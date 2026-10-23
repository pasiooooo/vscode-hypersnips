import { LatexDocumentState } from './latexDocumentState';
import * as vscode from 'vscode';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { openExplorer } from './openFileExplorer';
import { HSnippet } from './hsnippet';
import { HSnippetInstance } from './hsnippetInstance';
import { getAlignmentEdits, mapAlignmentOffset } from './latexAlignment';
import { getFontCharacterWidths } from './fontMetrics';
import { parse } from './parser';
import { getSnippetDir } from './utils';
import { getAutomaticCompletion, getCompletions, CompletionInfo } from './completion';
import {
    getLatexContext,
    getSmartEnterPlan,
    getSmartEnterRecoveryPlan,
    shouldInsertAlignmentSeparator,
    ALIGNMENT_SEPARATOR_ENVIRONMENTS,
    LatexContextOptions,
    TextEdit,
} from './latexEdit';
import {
    CONVERTIBLE_ENVIRONMENTS,
    WRAPPABLE_MATH_ENVIRONMENTS,
    conversionNeedsTableArguments,
    createEnvironmentNameOnlyRenamePlan,
    createEnvironmentNameSyncPlan,
    createEnvironmentConversionPlan,
    createUnwrapMathStructurePlan,
    createWrapCurrentMathStructurePlan,
    createWrapEnvironmentPlan,
    findDisplayMathDelimiterAt,
    findLatexEnvironmentPairAt,
    formatTableArguments,
    isValidEnvironmentName,
    isTableLikeEnvironment,
    SingleTextChange,
} from './environmentConvert';
import { registerSnippetManager } from './snippetManager';
import {
    discoverSnippetProfiles,
    ensureProfileDir,
    getSnippetFilesForProfile,
    normalizeProfileName,
} from './snippetProfiles';

let SNIPPETS_BY_LANGUAGE: Map<string, HSnippet[]> = new Map();
let pendingSnippetLoad: { key: string; promise: Promise<void> } | undefined;
let profileReload: {
    key: string;
    promise?: Promise<void>;
    updating: boolean;
    observed: boolean;
} | undefined;
let snippetLoadSequence = 0;
const SNIPPET_STACK: HSnippetInstance[] = [];

let insertingSnippet = false;
let applyingLatexEdit = false;
let aligningLatex = false;
let alignmentTimer: ReturnType<typeof setTimeout> | undefined;
let latexContextOptionsCache:
    | {
        options: LatexContextOptions;
        key: string;
    }
    | undefined;
let documentStates = new WeakMap<vscode.TextDocument, { current: LatexDocumentState; previous?: LatexDocumentState }>();
const contextValues = new Map<string, boolean>();

function getDocumentState(document: vscode.TextDocument) {
    const { options, key } = getLatexContextOptionsState();
    const cached = documentStates.get(document);
    if (cached && cached.current.version == document.version && cached.current.optionsKey == key) return cached.current;
    const current = new LatexDocumentState(document.getText(), document.version, options);
    const previous = cached?.current.version == document.version - 1 && cached.current.optionsKey == key
        ? cached.current : undefined;
    documentStates.set(document, { current, previous });
    return current;
}

function updateDocumentState(event: vscode.TextDocumentChangeEvent) {
    const { options, key } = getLatexContextOptionsState();
    const cached = documentStates.get(event.document);
    const previous = cached?.current;
    if (previous && previous.version == event.document.version && previous.optionsKey == key) return cached!;
    let current: LatexDocumentState;
    if (previous && previous.version + 1 == event.document.version && previous.optionsKey == key) {
        try {
            current = previous.update(event.contentChanges, event.document.version, options);
        } catch {
            current = new LatexDocumentState(event.document.getText(), event.document.version, options);
        }
    } else {
        current = new LatexDocumentState(event.document.getText(), event.document.version, options);
    }
    const states = { current, previous: previous?.version == event.document.version - 1 ? previous : undefined };
    documentStates.set(event.document, states);
    return states;
}

function isLatexLikeDocument(document: vscode.TextDocument) {
    return ['latex', 'tex', 'markdown'].includes(document.languageId.toLowerCase());
}

function getStringArrayConfiguration(path: string) {
    let value = vscode.workspace.getConfiguration('hsnips').get<string[]>(path);
    return Array.isArray(value) ? value.filter((item) => typeof item == 'string') : [];
}

function getActiveSnippetProfile() {
    return normalizeProfileName(
        vscode.workspace.getConfiguration('hsnips').get<string>('profiles.activeProfile')
    );
}

function readLatexContextOptions(): LatexContextOptions {
    return {
        extraMathEnvironments: getStringArrayConfiguration('context.extraMathEnvironments'),
        extraRowBreakEnvironments: getStringArrayConfiguration('context.extraRowBreakEnvironments'),
        extraAlignmentEnvironments: getStringArrayConfiguration('context.extraAlignmentEnvironments'),
        extraTextLikeCommands: getStringArrayConfiguration('context.extraTextLikeCommands'),
    };
}

function getLatexContextOptionsState() {
    if (!latexContextOptionsCache) {
        let options = readLatexContextOptions();
        latexContextOptionsCache = {
            options,
            key: JSON.stringify(options),
        };
    }
    return latexContextOptionsCache;
}

function getLatexContextOptions(): LatexContextOptions {
    return getLatexContextOptionsState().options;
}

function getCachedLatexContext(document: vscode.TextDocument, position: vscode.Position) {
    if (!isLatexLikeDocument(document)) {
        return undefined;
    }

    return getDocumentState(document).contextAt(document.offsetAt(position));
}

function updateMathContext(editor: vscode.TextEditor | undefined) {
    let inLatexMath = false;
    let canSmartEnter = false;
    let canSmartTab = false;

    if (editor) {
        let context = getCachedLatexContext(editor.document, editor.selection.active);
        if (context) {
            inLatexMath = context.inMath;
            canSmartEnter = context.canSmartEnter;
            canSmartTab = context.canSmartTab;
        }
    }

    setMathContext('hsnips.inLatexMath', inLatexMath);
    setMathContext('hsnips.canSmartEnter', canSmartEnter);
    setMathContext('hsnips.canSmartTab', canSmartTab);
    setMathContext('hsnips.canInsertAlignmentSeparator', canSmartTab);
}

function setMathContext(key: string, value: boolean) {
    if (contextValues.get(key) == value) return;
    contextValues.set(key, value);
    void vscode.commands.executeCommand('setContext', key, value);
}

async function typeText(text: string) {
    await vscode.commands.executeCommand('type', { text });
}

async function applyEdits(editor: vscode.TextEditor, edits: TextEdit[]) {
    applyingLatexEdit = true;
    try {
        return await editor.edit((editBuilder) => {
            for (let edit of edits) {
                editBuilder.replace(
                    new vscode.Range(
                        editor.document.positionAt(edit.start),
                        editor.document.positionAt(edit.end)
                    ),
                    edit.text
                );
            }
        });
    } finally {
        applyingLatexEdit = false;
    }
}

function isAutoAlignEnabled(document: vscode.TextDocument) {
    return vscode.workspace.getConfiguration('hsnips', {
        uri: document.uri, languageId: document.languageId,
    }).get<boolean>('autoAlign.enabled', true);
}

function scheduleAlignment(editor: vscode.TextEditor, event: vscode.TextDocumentChangeEvent) {
    if (aligningLatex) return;
    if (alignmentTimer) clearTimeout(alignmentTimer);
    if (event.reason || !isLatexLikeDocument(event.document) ||
        !event.contentChanges.length || !isAutoAlignEnabled(event.document)) return;

    let version = event.document.version;
    let offsets: number[] = [];
    let delta = 0;
    for (let change of [...event.contentChanges].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
        let start = change.rangeOffset + delta;
        offsets.push(start, start + change.text.length);
        for (let match of change.text.matchAll(/\\begin\s*\{[^}]+\}/g)) {
            offsets.push(start + match.index! + match[0].length);
        }
        delta += change.text.length - change.rangeLength;
    }

    alignmentTimer = setTimeout(async () => {
        alignmentTimer = undefined;
        if (vscode.window.activeTextEditor != editor || editor.document.version != version ||
            !isAutoAlignEnabled(editor.document)) return;
        let snapshot = getDocumentState(editor.document);
        let text = snapshot.text;
        let options = getLatexContextOptions();
        let alignmentEnvironments = new Set([
            ...ALIGNMENT_SEPARATOR_ENVIRONMENTS,
            ...(options.extraAlignmentEnvironments || []),
        ]);
        let environments = new Map<string, { offset: number; beginEnd: number; endStart: number }>();
        for (let offset of offsets) {
            let context = snapshot.contextAt(offset);
            if (context.inMarkdownCode || context.inTextLikeCommand || context.inVerbatimLikeEnvironment) continue;
            if (!context.canSmartTab && !(context.inComment && context.environmentStack.length > 0)) continue;
            let pair = snapshot.environmentPairAt(offset);
            if (pair && alignmentEnvironments.has(pair.name)) {
                environments.set(`${pair.beginStart}:${pair.endEnd}`,
                    { offset, beginEnd: pair.beginEnd, endStart: pair.endStart });
            }
        }
        if (!environments.size) return;
        let requestIsCurrent = () => vscode.window.activeTextEditor == editor &&
            editor.document.version == version && isAutoAlignEnabled(editor.document);
        let font = vscode.workspace.getConfiguration('editor', {
            uri: editor.document.uri, languageId: editor.document.languageId,
        });
        let characterWidths = vscode.env.remoteName ? new Map<string, number>() : await getFontCharacterWidths({
            family: font.get<string>('fontFamily', 'Consolas, monospace'),
            size: font.get<number>('fontSize', 14),
            weight: font.get<string>('fontWeight', 'normal'),
            letterSpacing: font.get<number>('letterSpacing', 0),
        }, [...environments.values()].map(({ beginEnd, endStart }) => text.slice(beginEnd, endStart)).join(''),
        requestIsCurrent);
        if (!requestIsCurrent()) return;
        let tabSize = typeof editor.options.tabSize == 'number' ? editor.options.tabSize : 4;
        let edits = new Map<number, TextEdit>();
        for (let { offset } of environments.values()) {
            for (let edit of getAlignmentEdits(text, offset, options, tabSize, characterWidths, snapshot)) {
                edits.set(edit.start, edit);
            }
        }
        if (!edits.size) return;
        let alignmentEdits = [...edits.values()];
        let selections = editor.selections.map((selection) => ({
            anchor: mapAlignmentOffset(editor.document.offsetAt(selection.anchor), alignmentEdits),
            active: mapAlignmentOffset(editor.document.offsetAt(selection.active), alignmentEdits),
        }));
        aligningLatex = true;
        applyingLatexEdit = true;
        try {
            let applied = await editor.edit((builder) => {
                for (let edit of alignmentEdits) {
                    builder.replace(new vscode.Range(
                        editor.document.positionAt(edit.start),
                        editor.document.positionAt(edit.end)
                    ), edit.text);
                }
            }, { undoStopBefore: false, undoStopAfter: false });
            if (applied && editor.document.version == version + 1) {
                editor.selections = selections.map((selection) => new vscode.Selection(
                    editor.document.positionAt(selection.anchor),
                    editor.document.positionAt(selection.active)
                ));
            }
        } catch (error) {
            console.error(error);
        } finally {
            aligningLatex = false;
            applyingLatexEdit = false;
        }
    }, 150);
}

async function smartEnter(editor: vscode.TextEditor) {
    if (editor.selections.length != 1 || !editor.selection.isEmpty) {
        await typeText('\n');
        return;
    }

    let snapshot = getDocumentState(editor.document);
    let text = snapshot.text;
    let offset = editor.document.offsetAt(editor.selection.active);
    let plan = getSmartEnterPlan(text, offset, getLatexContextOptions(), snapshot);

    if (!plan.handled) {
        await typeText('\n');
        return;
    }

    let inserted = await applyEdits(editor, plan.edits);
    if (inserted) {
        let newPosition = editor.document.positionAt(plan.cursorOffset as number);
        editor.selection = new vscode.Selection(newPosition, newPosition);
        editor.revealRange(new vscode.Range(newPosition, newPosition));
    }
}

function isPlainEnterChange(change: vscode.TextDocumentContentChangeEvent) {
    return change.rangeLength == 0 && /^\r?\n[ \t]*$/.test(change.text);
}

async function recoverSmartEnterAfterPlainEnter(
    editor: vscode.TextEditor,
    change: vscode.TextDocumentContentChangeEvent,
    previous: LatexDocumentState | undefined,
    current: LatexDocumentState
) {
    if (applyingLatexEdit || !isPlainEnterChange(change)) {
        return false;
    }

    let currentText = current.text;
    let beforeEnterText = previous?.text ?? (currentText.slice(0, change.rangeOffset) + currentText.slice(change.rangeOffset + change.text.length));
    let plan = getSmartEnterRecoveryPlan(
        beforeEnterText,
        change.rangeOffset,
        currentText,
        getLatexContextOptions(),
        previous
    );

    if (!plan.handled) {
        return false;
    }

    let inserted = await applyEdits(editor, plan.edits);
    if (inserted && typeof plan.cursorOffset == 'number') {
        let newPosition = editor.document.positionAt(plan.cursorOffset);
        editor.selection = new vscode.Selection(newPosition, newPosition);
        editor.revealRange(new vscode.Range(newPosition, newPosition));
    }

    return inserted;
}

async function recoverEnvironmentNameSyncAfterChange(
    editor: vscode.TextEditor,
    change: vscode.TextDocumentContentChangeEvent,
    previous: LatexDocumentState | undefined,
    current: LatexDocumentState
) {
    if (applyingLatexEdit || !previous || !isLatexLikeDocument(editor.document)) {
        return false;
    }

    let plan = createEnvironmentNameSyncPlan(
        previous.text,
        current.text,
        {
            rangeOffset: change.rangeOffset,
            rangeLength: change.rangeLength,
            text: change.text,
        },
        getLatexContextOptions(),
        previous
    );

    if (!plan.handled) {
        return false;
    }

    applyingLatexEdit = true;
    try {
        return await editor.edit(
            (editBuilder) => {
                for (let edit of plan.edits) {
                    editBuilder.replace(
                        new vscode.Range(
                            editor.document.positionAt(edit.start),
                            editor.document.positionAt(edit.end)
                        ),
                        edit.text
                    );
                }
            },
            { undoStopBefore: false, undoStopAfter: false }
        );
    } finally {
        applyingLatexEdit = false;
    }
}

async function nextSnippetPlaceholder() {
    if (SNIPPET_STACK[0] && !SNIPPET_STACK[0].nextPlaceholder()) {
        SNIPPET_STACK.shift();
    }
    await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
}

async function fallbackTab() {
    if (SNIPPET_STACK.length) {
        await nextSnippetPlaceholder();
        return;
    }

    try {
        await vscode.commands.executeCommand('editor.action.insertTab');
    } catch {
        await typeText('\t');
    }
}

async function smartTab(editor: vscode.TextEditor) {
    let snapshot = getDocumentState(editor.document);
    let text = snapshot.text;
    let options = getLatexContextOptions();
    let shouldInsertSeparator = editor.selections.every((selection) => {
        return shouldInsertAlignmentSeparator(text, editor.document.offsetAt(selection.active), options, snapshot);
    });

    if (!shouldInsertSeparator) {
        await fallbackTab();
        return;
    }

    await editor.edit((editBuilder) => {
        for (let selection of editor.selections) {
            editBuilder.replace(selection, ' & ');
        }
    });
}

async function convertEnvironment(editor: vscode.TextEditor) {
    let snapshot = getDocumentState(editor.document);
    let text = snapshot.text;
    let options = getLatexContextOptions();
    let selection = editor.selection;
    let offset = editor.document.offsetAt(selection.active);
    let selectionStart = editor.document.offsetAt(selection.start);
    let selectionEnd = editor.document.offsetAt(selection.end);
    let environmentPair = findLatexEnvironmentPairAt(text, offset, options, snapshot);
    let delimiterPair = findDisplayMathDelimiterAt(text, offset, snapshot);
    let currentName = environmentPair?.name;
    let target = await vscode.window.showQuickPick(
        CONVERTIBLE_ENVIRONMENTS
            .filter((environment) => environment != currentName)
            .map((environment) => ({
                label: environment,
                description: isTableLikeEnvironment(environment) ? 'table-like environment' : 'math environment',
            })),
        {
            placeHolder: currentName
                ? `Convert ${currentName} to...`
                : selection.isEmpty
                    ? 'Convert display math to...'
                    : 'Wrap selection with...',
        }
    );

    if (!target) {
        return;
    }

    let targetArguments = '';
    if (isTableLikeEnvironment(target.label)) {
        let needsArguments = !environmentPair || conversionNeedsTableArguments(text, offset, target.label, snapshot);
        if (needsArguments) {
            let columnSpec = await vscode.window.showInputBox({
                prompt: `Column specification for ${target.label}`,
                value: 'c',
                ignoreFocusOut: true,
            });
            if (columnSpec === undefined) {
                return;
            }
            targetArguments = formatTableArguments(target.label, columnSpec);
        }
    }

    let plan = !selection.isEmpty && !environmentPair && !delimiterPair
        ? createWrapEnvironmentPlan(text, selectionStart, selectionEnd, target.label, targetArguments)
        : createEnvironmentConversionPlan(text, offset, target.label, targetArguments, options, snapshot);

    if (!plan.handled) {
        vscode.window.showInformationMessage('No LaTeX environment or display math delimiter found at the cursor.');
        return;
    }

    let inserted = await applyEdits(editor, plan.edits);
    if (inserted && typeof plan.cursorOffset == 'number') {
        let newPosition = editor.document.positionAt(plan.cursorOffset);
        editor.selection = new vscode.Selection(newPosition, newPosition);
        editor.revealRange(new vscode.Range(newPosition, newPosition));
    }
}

async function renameMatchingEnvironment(editor: vscode.TextEditor) {
    let snapshot = getDocumentState(editor.document);
    let text = snapshot.text;
    let offset = editor.document.offsetAt(editor.selection.active);
    let pair = findLatexEnvironmentPairAt(text, offset, getLatexContextOptions(), snapshot);
    if (!pair) {
        vscode.window.showInformationMessage('No LaTeX environment found at the cursor.');
        return;
    }

    let targetName = await vscode.window.showInputBox({
        prompt: `Rename matching \\begin/\\end for ${pair.name}`,
        value: pair.name,
        ignoreFocusOut: true,
        validateInput(value) {
            return isValidEnvironmentName(value.trim()) ? undefined : 'Environment name cannot be empty or contain braces/whitespace.';
        },
    });
    if (targetName === undefined) {
        return;
    }

    let plan = createEnvironmentNameOnlyRenamePlan(pair, targetName);
    if (!plan.handled) {
        return;
    }

    let inserted = await applyEdits(editor, plan.edits);
    if (inserted && typeof plan.cursorOffset == 'number') {
        let newPosition = editor.document.positionAt(plan.cursorOffset);
        editor.selection = new vscode.Selection(newPosition, newPosition);
        editor.revealRange(new vscode.Range(newPosition, newPosition));
    }
}

async function pickMathStructureTarget() {
    let target = await vscode.window.showQuickPick(
        WRAPPABLE_MATH_ENVIRONMENTS.map((environment) => ({
            label: environment,
            description: isTableLikeEnvironment(environment) ? 'matrix/table-like environment' : 'math environment',
        })),
        { placeHolder: 'Wrap with...' }
    );
    return target?.label;
}

async function getTargetArgumentsIfNeeded(targetName: string) {
    if (!isTableLikeEnvironment(targetName)) {
        return '';
    }

    let columnSpec = await vscode.window.showInputBox({
        prompt: `Column specification for ${targetName}`,
        value: 'c',
        ignoreFocusOut: true,
    });
    if (columnSpec === undefined) {
        return undefined;
    }
    return formatTableArguments(targetName, columnSpec);
}

async function wrapMathStructure(editor: vscode.TextEditor) {
    let targetName = await pickMathStructureTarget();
    if (!targetName) {
        return;
    }

    let targetArguments = await getTargetArgumentsIfNeeded(targetName);
    if (targetArguments === undefined) {
        return;
    }

    let snapshot = getDocumentState(editor.document);
    let text = snapshot.text;
    let selection = editor.selection;
    let selectionStart = editor.document.offsetAt(selection.start);
    let selectionEnd = editor.document.offsetAt(selection.end);
    let plan = !selection.isEmpty
        ? createWrapEnvironmentPlan(text, selectionStart, selectionEnd, targetName, targetArguments)
        : createWrapCurrentMathStructurePlan(
            text,
            editor.document.offsetAt(selection.active),
            targetName,
            targetArguments,
            getLatexContextOptions(),
            snapshot
        );

    if (!plan.handled) {
        vscode.window.showInformationMessage('Select text or place the cursor inside a math structure to wrap.');
        return;
    }

    let inserted = await applyEdits(editor, plan.edits);
    if (inserted && typeof plan.cursorOffset == 'number') {
        let newPosition = editor.document.positionAt(plan.cursorOffset);
        editor.selection = new vscode.Selection(newPosition, newPosition);
        editor.revealRange(new vscode.Range(newPosition, newPosition));
    }
}

async function unwrapMathStructure(editor: vscode.TextEditor) {
    let snapshot = getDocumentState(editor.document);
    let text = snapshot.text;
    let plan = createUnwrapMathStructurePlan(
        text,
        editor.document.offsetAt(editor.selection.active),
        getLatexContextOptions(),
        snapshot
    );

    if (!plan.handled) {
        vscode.window.showInformationMessage('No supported math structure found at the cursor.');
        return;
    }

    let inserted = await applyEdits(editor, plan.edits);
    if (inserted && typeof plan.cursorOffset == 'number') {
        let newPosition = editor.document.positionAt(plan.cursorOffset);
        editor.selection = new vscode.Selection(newPosition, newPosition);
        editor.revealRange(new vscode.Range(newPosition, newPosition));
    }
}

function snippetLoadKey() {
    return JSON.stringify([getSnippetDir(), getActiveSnippetProfile()]);
}

function loadSnippets(): Promise<void> {
    const snippetDir = getSnippetDir();
    const profile = getActiveSnippetProfile();
    const key = JSON.stringify([snippetDir, profile]);
    if (pendingSnippetLoad?.key == key) return pendingSnippetLoad.promise;
    const sequence = ++snippetLoadSequence;
    const promise = Promise.resolve().then(() => {
        const next = new Map<string, HSnippet[]>();
        if (!existsSync(snippetDir)) mkdirSync(snippetDir);
        for (let entry of getSnippetFilesForProfile(snippetDir, profile)) {
            let snippetList = next.get(entry.language);
            if (!snippetList) {
                snippetList = [];
                next.set(entry.language, snippetList);
            }
            snippetList.push(...parse(readFileSync(entry.filePath, 'utf8')));
        }
        const globalSnippets = next.get('all');
        if (globalSnippets) {
            for (let [language, snippetList] of next) {
                if (language != 'all') snippetList.push(...globalSnippets);
            }
        }
        for (let snippetList of next.values()) {
            snippetList.sort((a, b) => b.priority - a.priority);
        }
        if (sequence == snippetLoadSequence) SNIPPETS_BY_LANGUAGE = next;
    }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to load snippets: ${message}`);
    }).finally(() => {
        if (pendingSnippetLoad?.promise == promise) pendingSnippetLoad = undefined;
    });
    pendingSnippetLoad = { key, promise };
    return promise;
}

function loadSnippetProfile(): Promise<void> {
    const operation = profileReload;
    if (operation && operation.key == snippetLoadKey()) {
        operation.observed = true;
        operation.promise ??= loadSnippets();
        if (!operation.updating) profileReload = undefined;
        return operation.promise;
    }
    profileReload = undefined;
    return loadSnippets();
}

async function selectSnippetProfile() {
    let snippetDir = getSnippetDir();
    if (!existsSync(snippetDir)) {
        mkdirSync(snippetDir);
    }

    let activeProfile = getActiveSnippetProfile();
    let profiles = discoverSnippetProfiles(snippetDir);
    let picked = await vscode.window.showQuickPick(
        [
            {
                label: 'Base only',
                description: activeProfile ? undefined : 'current',
                profile: '',
            },
            ...profiles.map((profile) => ({
                label: profile,
                description: profile == activeProfile ? 'current' : undefined,
                profile,
            })),
        ],
        { placeHolder: 'Select active snippet profile' }
    );

    if (!picked) {
        return;
    }

    const configuration = vscode.workspace.getConfiguration('hsnips');
    const unchanged = picked.profile == (configuration.get<string>('profiles.activeProfile') ?? '');
    const operation = {
        key: JSON.stringify([snippetDir, picked.profile]),
        promise: undefined as Promise<void> | undefined,
        updating: true,
        observed: false,
    };
    profileReload = operation;
    let updated = false;
    try {
        await configuration.update('profiles.activeProfile', picked.profile, vscode.ConfigurationTarget.Global);
        updated = true;
        await (operation.promise ??= loadSnippets());
    } finally {
        operation.updating = false;
        if (profileReload == operation && (!updated || unchanged || operation.observed)) {
            profileReload = undefined;
        }
    }
    vscode.window.showInformationMessage(
        picked.profile ? `vscode-hypersnips profile: ${picked.profile}` : "vscode-hypersnips profile: base only"
    );
}

async function openActiveSnippetProfile() {
    let snippetDir = getSnippetDir();
    let activeProfile = getActiveSnippetProfile();
    if (!activeProfile) {
        vscode.window.showInformationMessage('No active snippet profile selected. Opening the base snippets directory.');
        openExplorer(snippetDir);
        return;
    }

    openExplorer(ensureProfileDir(snippetDir, activeProfile));
}

// This function may be called after a snippet expansion, in which case the original text was
// replaced by the snippet label, or it may be called directly, as in the case of an automatic
// expansion. Depending on which case it is, we have to delete a different editor range before
// triggering the real hsnip expansion.
export async function expandSnippet(
    completion: CompletionInfo,
    editor: vscode.TextEditor,
    snippetExpansion = false
) {
    let snippetInstance = new HSnippetInstance(
        completion.snippet,
        editor,
        completion.range.start,
        completion.groups
    );

    let insertionRange: vscode.Range | vscode.Position = completion.range.start;

    // The separate deletion is a workaround for a VsCodeVim bug, where when we trigger a snippet which
    // has a replacement range, it will go into NORMAL mode, see issues #28 and #36.

    // TODO: Go back to inserting the snippet and removing in a single command once the VsCodeVim bug
    // is fixed.

    insertingSnippet = true;
    await editor.edit(
        (eb) => {
            eb.delete(snippetExpansion ? completion.completionRange : completion.range);
        },
        { undoStopAfter: false, undoStopBefore: !snippetExpansion }
    );

    await editor.insertSnippet(snippetInstance.snippetString, insertionRange, {
        undoStopAfter: false,
        undoStopBefore: false,
    });

    if (snippetInstance.selectedPlaceholder != 0) SNIPPET_STACK.unshift(snippetInstance);
    insertingSnippet = false;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new vscode.Disposable(() => {
        if (alignmentTimer) clearTimeout(alignmentTimer);
    }));
    loadSnippets();
    if (vscode.window.activeTextEditor && isLatexLikeDocument(vscode.window.activeTextEditor.document)) {
        getDocumentState(vscode.window.activeTextEditor.document);
    }
    updateMathContext(vscode.window.activeTextEditor);
    registerSnippetManager(context, loadSnippets, getActiveSnippetProfile);

    context.subscriptions.push(
        vscode.commands.registerCommand('hsnips.openSnippetsDir', () => openExplorer(getSnippetDir()))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hsnips.openSnippetFile', async () => {
            let snippetDir = getSnippetDir();
            let files = readdirSync(snippetDir);
            let selectedFile = await vscode.window.showQuickPick(files);

            if (selectedFile) {
                let document = await vscode.workspace.openTextDocument(path.join(snippetDir, selectedFile));
                vscode.window.showTextDocument(document);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hsnips.reloadSnippets', () => loadSnippets())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hsnips.selectProfile', () => selectSnippetProfile())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hsnips.openActiveProfile', () => openActiveSnippetProfile())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hsnips.leaveSnippet', () => {
            while (SNIPPET_STACK.length) SNIPPET_STACK.pop();
            vscode.commands.executeCommand('leaveSnippet');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hsnips.nextPlaceholder', () => {
            return nextSnippetPlaceholder();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hsnips.prevPlaceholder', () => {
            if (SNIPPET_STACK[0] && !SNIPPET_STACK[0].prevPlaceholder()) {
                SNIPPET_STACK.shift();
            }
            vscode.commands.executeCommand('jumpToPrevSnippetPlaceholder');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hsnips.smartEnter', (editor) => {
            return smartEnter(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hsnips.matrixTab', (editor) => {
            return smartTab(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hsnips.smartTab', (editor) => {
            return smartTab(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hsnips.convertEnvironment', (editor) => {
            return convertEnvironment(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hsnips.renameMatchingEnvironment', (editor) => {
            return renameMatchingEnvironment(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hsnips.wrapMathStructure', (editor) => {
            return wrapMathStructure(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hsnips.unwrapMathStructure', (editor) => {
            return unwrapMathStructure(editor);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId == 'hsnips') {
                loadSnippets();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand(
            'hsnips.expand',
            (editor, _, completion: CompletionInfo) => {
                expandSnippet(completion, editor, true);
            }
        )
    );

    function getDocumentLatexContext(document: vscode.TextDocument, offset: number) {
        return getCachedLatexContext(document, document.positionAt(offset));
    }

    function getEditorLatexContext(editor: vscode.TextEditor, position = editor.selection.start) {
        return getDocumentLatexContext(editor.document, editor.document.offsetAt(position));
    }

    function canExpandSnippetInContext(
        snippet: HSnippet,
        latexContext: ReturnType<typeof getEditorLatexContext>
    ) {
        if (snippet.math) {
            return Boolean(latexContext?.canExpandMathSnippet);
        }
        if (snippet.text && latexContext?.inMath) {
            return false;
        }
        return true;
    }

    // Forward all document changes so that the active snippet can update its related blocks.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (e) => {
            const states = isLatexLikeDocument(e.document) ? updateDocumentState(e) : undefined;
            let activeEditor = vscode.window.activeTextEditor;
            try {
                if (activeEditor && e.document == activeEditor.document) {
                    updateMathContext(activeEditor);
                    scheduleAlignment(activeEditor, e);
                }

                if (SNIPPET_STACK.length && SNIPPET_STACK[0].editor.document == e.document) {
                    SNIPPET_STACK[0].update(e.contentChanges);
                }

                if (insertingSnippet || aligningLatex) return;

                let mainChange = e.contentChanges[0];

                if (!mainChange) return;

                if (
                    activeEditor &&
                    e.document == activeEditor.document &&
                    e.contentChanges.length == 1 && states &&
                    await recoverEnvironmentNameSyncAfterChange(
                        activeEditor,
                        mainChange,
                        states.previous,
                        states.current
                    )
                ) {
                    return;
                }

                if (activeEditor && e.document == activeEditor.document && isPlainEnterChange(mainChange)) {
                    void recoverSmartEnterAfterPlainEnter(
                        activeEditor, mainChange,
                        e.contentChanges.length == 1 ? states?.previous : undefined,
                        states?.current ?? getDocumentState(e.document)
                    ).then(undefined, console.error);
                    return;
                }

                // Let's try to detect only events that come from keystrokes.
                if (mainChange.text.length != 1) return;

                let snippets = SNIPPETS_BY_LANGUAGE.get(e.document.languageId.toLowerCase());
                if (!snippets) snippets = SNIPPETS_BY_LANGUAGE.get('all');
                if (!snippets) return;
                let editor = vscode.window.activeTextEditor;
                if (!editor || e.document != editor.document) return;

                let latexContext = getEditorLatexContext(editor);
                snippets = snippets.filter((snippet) => canExpandSnippetInContext(snippet, latexContext));

                let mainChangePosition = mainChange.range.start.translate(0, mainChange.text.length);
                let completion = getAutomaticCompletion(e.document, mainChangePosition, snippets);

                if (completion) {
                    expandSnippet(completion, editor);
                    return;
                }
            } catch (error) {
                console.error(error);
            }
        })
    );

    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
        documentStates.delete(document);
    }));

    // Remove any stale snippet instances.
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(() => {
            while (SNIPPET_STACK.length) SNIPPET_STACK.pop();
            updateMathContext(vscode.window.activeTextEditor);
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                if (isLatexLikeDocument(editor.document)) getDocumentState(editor.document);
            }
            updateMathContext(editor);
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => {
            while (SNIPPET_STACK.length) {
                if (e.selections.some((s) => SNIPPET_STACK[0].range.contains(s))) {
                    break;
                }
                SNIPPET_STACK.shift();
            }
            updateMathContext(e.textEditor);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('hsnips.autoAlign') && alignmentTimer) {
                clearTimeout(alignmentTimer);
                alignmentTimer = undefined;
            }
            if (event.affectsConfiguration('hsnips.context')) {
                documentStates = new WeakMap();
                latexContextOptionsCache = undefined;
                updateMathContext(vscode.window.activeTextEditor);
            }
            if (event.affectsConfiguration('hsnips.profiles.activeProfile')) {
                void loadSnippetProfile();
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider([{ scheme: 'untitled' }, { scheme: 'file' }], {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
                let snippets = SNIPPETS_BY_LANGUAGE.get(document.languageId.toLowerCase());
                if (!snippets) snippets = SNIPPETS_BY_LANGUAGE.get('all');
                if (!snippets) return;
                let editor = vscode.window.activeTextEditor;
                if (!editor || document != editor.document) return;
                let latexContext = getDocumentLatexContext(document, document.offsetAt(position));
                snippets = snippets.filter((snippet) => canExpandSnippetInContext(snippet, latexContext));

                let completions = getCompletions(document, position, snippets);
                if (completions && Array.isArray(completions)) {
                    return completions.map((c) => c.toCompletionItem());
                }
            },
        })
    );
}
