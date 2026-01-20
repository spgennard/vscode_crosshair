'use strict';

import {
    window, workspace, DecorationRangeBehavior,
    TextEditorDecorationType, ExtensionContext,
    Position, Range,
    TextEditor,
    StatusBarItem,
    StatusBarAlignment,
    commands,
    ConfigurationTarget,
    WorkspaceEdit
} from 'vscode';

// Interface to track added spaces
interface AddedSpaces {
    line: number;
    startPos: number;
    length: number;
}

// Map to track added spaces by document URI
const addedSpacesMap = new Map<string, AddedSpaces[]>();

// Map to store cursor positions during save/restore cycle
const savedCursorPositions = new Map<string, Position>();

let toggleCrosshair: StatusBarItem;
let isActive: boolean = getEnabledFromConfig();
let decorationType: TextEditorDecorationType | undefined;
let decorationTypeBlock: TextEditorDecorationType | undefined;
let selectionUpdateTimeout: NodeJS.Timeout | undefined;
let updateTimeout: NodeJS.Timeout | undefined;
// Guard flag to prevent feedback loops when we modify the document
let isUpdatingDecorations: boolean = false;

// Cached configuration values to avoid repeated config reads
let cachedSize: number | undefined;
let cachedRefreshRate: number | undefined;
let cachedAutoTabToSpaces: boolean | undefined;
let cachedAddWhitespace: boolean | undefined;

// Track last cursor position per document to skip redundant updates
const lastCursorPositions = new Map<string, { line: number; character: number }>();

// Reusable empty arrays to avoid allocations when clearing decorations
const EMPTY_RANGE_ARRAY: Range[] = [];

function getEnabledFromConfig(): boolean {
    const config = workspace.getConfiguration("crosshair");

    let enabled: boolean | undefined = config.get<boolean>("enabled");

    return enabled === undefined ? false : enabled;
}

function getSize(): number {
    if (cachedSize !== undefined) {
        return cachedSize;
    }
    const config = workspace.getConfiguration("crosshair");
    cachedSize = config.get<number>("size", 10);
    return cachedSize;
}

function getRefreshRate(): number {
    if (cachedRefreshRate !== undefined) {
        return cachedRefreshRate;
    }
    const config = workspace.getConfiguration("crosshair");
    cachedRefreshRate = config.get<number>("refreshRate", 500);
    return cachedRefreshRate;
}

function getAutoTabToSpaces(): boolean {
    if (cachedAutoTabToSpaces !== undefined) {
        return cachedAutoTabToSpaces;
    }
    const config = workspace.getConfiguration("crosshair");
    cachedAutoTabToSpaces = config.get<boolean>("autoTabToSpace", true);
    return cachedAutoTabToSpaces;
}

function getAddWhitespace(): boolean {
    if (cachedAddWhitespace !== undefined) {
        return cachedAddWhitespace;
    }
    const config = workspace.getConfiguration("crosshair");
    cachedAddWhitespace = config.get<boolean>("addWhitespace", true);
    return cachedAddWhitespace;
}

// Clear cached config values when configuration changes
function invalidateConfigCache(): void {
    cachedSize = undefined;
    cachedRefreshRate = undefined;
    cachedAutoTabToSpaces = undefined;
    cachedAddWhitespace = undefined;
}

function getDecorationTypeFromConfig(): TextEditorDecorationType {
    // Dispose existing decoration if it exists
    if (decorationType) {
        decorationType.dispose();
    }
    
    const config = workspace.getConfiguration("crosshair");
    const borderColor = config.get("borderColor");
    const borderWidth = config.get("borderWidth");
    decorationType = window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: `0 0 ${borderWidth} 0`,
        borderStyle: 'solid',
        rangeBehavior: DecorationRangeBehavior.ClosedClosed,
        borderColor: `${borderColor}`
    });
    return decorationType;
}

function getDecorationTypeCursorFromConfig(): TextEditorDecorationType {
    // Dispose existing decoration if it exists
    if (decorationTypeBlock) {
        decorationTypeBlock.dispose();
    }
    
    const config = workspace.getConfiguration("crosshair");
    const borderColor = config.get("borderColor");
    const borderWidth = config.get("borderWidth");
    decorationTypeBlock = window.createTextEditorDecorationType({
        borderStyle: 'solid',
        rangeBehavior: DecorationRangeBehavior.ClosedClosed,
        borderWidth: `0 0 0 ${borderWidth}`,
        borderColor: `${borderColor}`,
        backgroundColor: 'transparent'
    });

    return decorationTypeBlock;
}

async function removePreviouslyAddedSpaces(editor: TextEditor): Promise<void> {
    const documentUri = editor.document.uri.toString();
    const addedSpaces = addedSpacesMap.get(documentUri);
    
    if (!addedSpaces || addedSpaces.length === 0) {
        return;
    }

    // Sort by line number in descending order to avoid position shifts
    addedSpaces.sort((a, b) => b.line - a.line);

    const edit = new WorkspaceEdit();
    
    for (const space of addedSpaces) {
        // Check if the line still exists and has the spaces we added
        if (space.line < editor.document.lineCount) {
            const line = editor.document.lineAt(space.line);
            const endPos = line.text.length;
            const startPos = space.startPos;
            
            // Only remove if the spaces are still there and are at the end of the line
            if (endPos >= startPos + space.length) {
                const spacesToRemove = line.text.substring(startPos, startPos + space.length);
                // Check if it's only spaces (not user-added content)
                if (spacesToRemove.match(/^ *$/)) {
                    const range = new Range(
                        new Position(space.line, startPos),
                        new Position(space.line, startPos + space.length)
                    );
                    edit.delete(editor.document.uri, range);
                }
            }
        }
    }

    if (edit.size > 0) {
        await workspace.applyEdit(edit);
    }
    
    // Clear the tracking for this document
    addedSpacesMap.set(documentUri, []);
}

async function updateDecorationsOnEditor(editor: TextEditor, currentPosition: Position,
    decorationType: TextEditorDecorationType,
    decorationTypeBlock: TextEditorDecorationType) {

    // Prevent re-entry while we're updating
    if (isUpdatingDecorations) {
        return;
    }
    
    const documentUri = editor.document.uri.toString();
    const lastPos = lastCursorPositions.get(documentUri);
    
    // Skip update if cursor position hasn't changed (performance optimization)
    // This avoids redundant decoration updates and space manipulations
    if (lastPos && lastPos.line === currentPosition.line && lastPos.character === currentPosition.character) {
        return;
    }
    
    isUpdatingDecorations = true;
    
    try {
        // Update last known position
        lastCursorPositions.set(documentUri, { line: currentPosition.line, character: currentPosition.character });
        
        const shouldAddWhitespace = getAddWhitespace();
        
        // Only remove previously added spaces if cursor column changed
        // This avoids unnecessary edits when just moving up/down in same column
        const prevSpaces = addedSpacesMap.get(documentUri);
        const needsSpaceCleanup = shouldAddWhitespace && prevSpaces && prevSpaces.length > 0 &&
            (!lastPos || lastPos.character !== currentPosition.character);
        
        if (needsSpaceCleanup) {
            await removePreviouslyAddedSpaces(editor);
        }

    // Single decoration for the horizontal line at cursor position
    const newDecorations = [new Range(currentPosition, currentPosition)];

    let maxLines = editor.document.lineCount;
    let config_size: number = getSize();
    let start_cline: number = currentPosition.line - config_size + 1;
    let end_cline: number = currentPosition.line + config_size + 1;

    if (start_cline <= 0) {
        start_cline = 0;
    }

    if (end_cline >= maxLines) {
        end_cline = maxLines;
    }

    const newAddedSpaces: AddedSpaces[] = [];

    // Cache autoTabToSpaces value before loop to avoid repeated config reads
    const autoTabToSpaces = getAutoTabToSpaces();
    
    try {
        for (let p = start_cline; p < end_cline; p++) {
            if (p >= maxLines) {
                break;
            }
            let cline = editor.document.lineAt(p);
            let clineText = cline.text;
            if (clineText.indexOf("\t") !== -1) {
                if (!autoTabToSpaces) {
                    isActive = false;
                    window.showInformationMessage("Crosshair: Tabs found in document, extension is disabled");
                    return;
                }
                
                // Ask user for confirmation before destructive tab conversion
                const shouldConvert = await window.showWarningMessage(
                    'Document contains tabs. Convert entire document to spaces for crosshair display?',
                    'Convert', 'Disable Crosshair'
                );
                
                if (shouldConvert !== 'Convert') {
                    isActive = false;
                    window.showInformationMessage("Crosshair: Disabled due to tabs in document");
                    return;
                }
                
                await commands.executeCommand('editor.action.indentationToSpaces');
                // Don't reset loop to prevent infinite loops - just continue
                isActive = true;
            }
        }
    }
    catch (e) {
        console.log("crosshair tabconvert", e);
    }

    // First, add any necessary whitespace and wait for edits to complete
    const editSuccess = await editor.edit(edit => {
        try {
            for (let p = start_cline; p < end_cline; p++) {
                if (p >= maxLines) {
                    break;
                }
                let cline = editor.document.lineAt(p);
                let clineText = cline.text;
                let missing = currentPosition.character - clineText.length;

                // Only add whitespace if the configuration allows it
                if (shouldAddWhitespace && missing > 0) {
                    let s = " ".repeat(missing);
                    edit.insert(new Position(p, clineText.length), s);
                    
                    // Track the added spaces
                    newAddedSpaces.push({
                        line: p,
                        startPos: clineText.length,
                        length: missing
                    });
                }
            }
        }
        catch (e) {
            console.log("crosshair space filler", e);
        }
    });

    // Only proceed with decorations if edit was successful (or no edit needed)
    // This ensures document state is stable before applying decorations
    
    // Build vertical line decorations AFTER edits are complete
    // This ensures we read the updated line lengths
    const newDecorationsLines: Range[] = [];
    
    for (let p = start_cline; p < end_cline; p++) {
        if (p >= maxLines) {
            break;
        }
        // Re-read line after potential edits
        let cline = editor.document.lineAt(p);
        let lineLength = cline.text.length;
        
        // CRITICAL FIX: Only apply decoration if the line is long enough
        // to reach the cursor column. This prevents decorations from being
        // placed at invalid positions (like column 0 when cursor is elsewhere)
        // which causes the blinking issue.
        if (lineLength >= currentPosition.character) {
            let columnPos = new Position(p, currentPosition.character);
            newDecorationsLines.push(new Range(columnPos, columnPos));
        } else if (!shouldAddWhitespace && lineLength > 0) {
            // If not adding whitespace but line has content, place decoration
            // at end of line as a fallback (better than column 0)
            let columnPos = new Position(p, lineLength);
            newDecorationsLines.push(new Range(columnPos, columnPos));
        }
        // If line is empty and we're not adding whitespace, skip decoration
        // for this line entirely to avoid column 0 blinking
    }
        
    // Store the tracking information for this document only if we're adding whitespace
    if (shouldAddWhitespace) {
        addedSpacesMap.set(documentUri, newAddedSpaces);
    }
    
    editor.setDecorations(decorationType, newDecorations);
    editor.setDecorations(decorationTypeBlock, newDecorationsLines);
    
    } finally {
        isUpdatingDecorations = false;
    }
}

function updateDecorations(activeTextEditor: TextEditor,
    decorationType: TextEditorDecorationType,
    decorationTypeBlock: TextEditorDecorationType,
    updateAllVisibleEditors = false) {

    if (!isActive) {
        // Use reusable empty arrays to avoid allocations
        activeTextEditor.setDecorations(decorationType, EMPTY_RANGE_ARRAY);
        activeTextEditor.setDecorations(decorationTypeBlock, EMPTY_RANGE_ARRAY);
        
        // Remove any added spaces when crosshair is disabled
        if (getAddWhitespace()) {
            removePreviouslyAddedSpaces(activeTextEditor);
        }
        
        window.showTextDocument(activeTextEditor.document);
        return;
    }

    try {
        if (updateAllVisibleEditors) {
            window.visibleTextEditors.forEach((editor) => {
                updateDecorationsOnEditor(editor, editor.selection.active, decorationType, decorationTypeBlock);
            });
        }

        else {
            if (window.activeTextEditor) {
                updateDecorationsOnEditor(activeTextEditor, activeTextEditor.selection.active, decorationType, decorationTypeBlock);
            }
        }
    }
    catch (error) {
        console.log("crosshair 'updateDecorations' -->", error);
    } finally {
        return new Position(activeTextEditor.selection.active.line, activeTextEditor.selection.active.character);
    }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {

    decorationTypeBlock = getDecorationTypeCursorFromConfig();
    decorationType = getDecorationTypeFromConfig();

    // Listen for configuration changes to invalidate cache and update decorations
    const onConfigChange = workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('crosshair')) {
            invalidateConfigCache();
            // Recreate decoration types if visual settings changed
            if (e.affectsConfiguration('crosshair.borderColor') || 
                e.affectsConfiguration('crosshair.borderWidth')) {
                decorationType = getDecorationTypeFromConfig();
                decorationTypeBlock = getDecorationTypeCursorFromConfig();
            }
            // Trigger update with new settings
            if (window.activeTextEditor) {
                updateDecorations(window.activeTextEditor, decorationType!, decorationTypeBlock!);
            }
        }
    });
    context.subscriptions.push(onConfigChange);

    const onActiveEditorChange = window.onDidChangeActiveTextEditor(() => {
        if (window.activeTextEditor !== undefined) {
            try {
                updateDecorations(window.activeTextEditor, decorationType!, decorationTypeBlock!);
            } catch (error) {
                console.log("crosshair 'window.onDidChangeActiveTextEditor' -->", error);
            }
        }
    });
    context.subscriptions.push(onActiveEditorChange);

    const onSelectionChange = window.onDidChangeTextEditorSelection(() => {
        if (window.activeTextEditor !== undefined) {
            // Debounce selection changes to improve performance
            if (selectionUpdateTimeout) {
                clearTimeout(selectionUpdateTimeout);
            }
            selectionUpdateTimeout = setTimeout(() => {
                if (window.activeTextEditor) {
                    updateDecorations(window.activeTextEditor, decorationType!, decorationTypeBlock!);
                }
            }, 100); // 100ms debounce to reduce excessive updates
        }
    });
    context.subscriptions.push(onSelectionChange);

    workspace.onDidChangeTextDocument(event => {
        // Skip if we're the ones making the document changes (prevents feedback loop)
        if (isUpdatingDecorations) {
            return;
        }
        if (activeEditor && event.document === activeEditor.document) {
            triggerUpdateDecorations();
        }
    }, null, context.subscriptions);

    // Intercept save to remove added spaces before saving
    workspace.onWillSaveTextDocument(async (event) => {
        if (getAddWhitespace() && window.activeTextEditor && 
            event.document === window.activeTextEditor.document) {
            // Store current cursor position to restore spaces at correct location
            savedCursorPositions.set(event.document.uri.toString(), 
                                   window.activeTextEditor.selection.active);
            await removePreviouslyAddedSpaces(window.activeTextEditor);
        }
    }, null, context.subscriptions);

    // Re-add spaces after save completes for continued crosshair display
    workspace.onDidSaveTextDocument(async (document) => {
        const documentUri = document.uri.toString();
        const savedPosition = savedCursorPositions.get(documentUri);
        
        if (getAddWhitespace() && window.activeTextEditor && 
            document === window.activeTextEditor.document && isActive && savedPosition) {
            // Small delay to ensure save is complete
            setTimeout(() => {
                if (window.activeTextEditor && window.activeTextEditor.document === document) {
                    // Use saved cursor position, not current position to avoid race conditions
                    updateDecorationsOnEditor(window.activeTextEditor, savedPosition, 
                                             decorationType!, decorationTypeBlock!);
                }
                // Clean up stored position
                savedCursorPositions.delete(documentUri);
            }, 50);
        } else {
            // Clean up stored position if we're not restoring
            savedCursorPositions.delete(documentUri);
        }
    }, null, context.subscriptions);

    // Clean up tracking data when documents are closed to prevent memory leaks
    workspace.onDidCloseTextDocument((document) => {
        const documentUri = document.uri.toString();
        addedSpacesMap.delete(documentUri);
        savedCursorPositions.delete(documentUri);
        lastCursorPositions.delete(documentUri);
    }, null, context.subscriptions);

    var toggleCrosshairCommand = commands.registerCommand('crosshair.toggle_crosshair', function () {
        isActive = !isActive;
        const config = workspace.getConfiguration("crosshair");

        triggerUpdateDecorations();
        if (workspace.workspaceFolders === undefined) {
            config.update("enabled", isActive, ConfigurationTarget.Global);
        } else {
            config.update("enabled", isActive, ConfigurationTarget.Workspace);
        }
    });

    context.subscriptions.push(toggleCrosshairCommand);

    toggleCrosshair = window.createStatusBarItem(StatusBarAlignment.Right);
    toggleCrosshair.text = "+";
    toggleCrosshair.command = "crosshair.toggle_crosshair";
    toggleCrosshair.show();
    context.subscriptions.push(toggleCrosshair);

    let activeEditor = window.activeTextEditor;

    function updateDecorationsTimer() {
        if (!activeEditor) {
            return;
        }
        updateDecorations(activeEditor, decorationType!, decorationTypeBlock!);
    }

    function triggerUpdateDecorations() {
        if (updateTimeout) {
            clearTimeout(updateTimeout);
            updateTimeout = undefined;
        }
        updateTimeout = setTimeout(updateDecorationsTimer, getRefreshRate());
    }

    if (activeEditor) {
        triggerUpdateDecorations();
    }

    if (isActive === false) {
        window.setStatusBarMessage('Crosshair disabled', 5000);
    }

}

// this method is called when your extension is deactivated
export async function deactivate() {
    // Clean up all added spaces from all documents when extension is deactivated
    if (getAddWhitespace()) {
        for (const editor of window.visibleTextEditors) {
            await removePreviouslyAddedSpaces(editor);
        }
    }
    
    // Clear all timeouts
    if (selectionUpdateTimeout) {
        clearTimeout(selectionUpdateTimeout);
        selectionUpdateTimeout = undefined;
    }
    if (updateTimeout) {
        clearTimeout(updateTimeout);
        updateTimeout = undefined;
    }
    
    // Dispose decoration types
    decorationType?.dispose();
    decorationTypeBlock?.dispose();
    
    // Clear all tracking data
    addedSpacesMap.clear();
    savedCursorPositions.clear();
    lastCursorPositions.clear();
}
