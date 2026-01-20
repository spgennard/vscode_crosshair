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

function getEnabledFromConfig(): boolean {
    const config = workspace.getConfiguration("crosshair");

    let enabled: boolean | undefined = config.get<boolean>("enabled");

    return enabled === undefined ? false : enabled;
}

function getSize(): number {
    const config = workspace.getConfiguration("crosshair");

    return config.get<number>("size", 10);
}

function getRefreshRate(): number {
    const config = workspace.getConfiguration("crosshair");

    return config.get<number>("refreshRate", 500);
}

function getAutoTabToSpaces(): boolean {
    const config = workspace.getConfiguration("crosshair");

    return config.get<boolean>("autoTabToSpace", true);
}

function getAddWhitespace(): boolean {
    const config = workspace.getConfiguration("crosshair");

    return config.get<boolean>("addWhitespace", true);
}

function getDecorationTypeFromConfig(): TextEditorDecorationType {
    const config = workspace.getConfiguration("crosshair");
    const borderColor = config.get("borderColor");
    const borderWidth = config.get("borderWidth");
    const decorationType = window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: `0 0 ${borderWidth} 0`,
        borderStyle: 'solid',
        rangeBehavior: DecorationRangeBehavior.ClosedClosed,
        borderColor: `${borderColor}`
    });
    return decorationType;
}

function getDecorationTypeCursorFromConfig(): TextEditorDecorationType {
    const config = workspace.getConfiguration("crosshair");
    const borderColor = config.get("borderColor");
    const borderWidth = config.get("borderWidth");
    const decorationType = window.createTextEditorDecorationType({
        borderStyle: 'solid',
        rangeBehavior: DecorationRangeBehavior.ClosedClosed,
        borderWidth: `0 0 0 ${borderWidth}`,
        borderColor: `${borderColor}`,
        backgroundColor: 'transparent'
    });

    return decorationType;
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

export async function convertToTabsPicker(): Promise<boolean> {
    let i = 0;
    const result = await window.showQuickPick(['Convert', 'Disable'], {
        placeHolder: 'crosshair extensions found tabs in current document\n \'Convert\' to spaces or \'Disable\'?'
    });

    return `${result}` === "Convert" ? true : false;
}

async function updateDecorationsOnEditor(editor: TextEditor, currentPosition: Position,
    decorationType: TextEditorDecorationType,
    decorationTypeBlock: TextEditorDecorationType) {

    const shouldAddWhitespace = getAddWhitespace();
    
    // Only remove previously added spaces if we're still in whitespace mode
    // to avoid cleanup loops when the setting changes
    if (shouldAddWhitespace) {
        await removePreviouslyAddedSpaces(editor);
    }

    const newDecorations = [new Range(currentPosition, currentPosition)];
    const newDecorationsLines = [new Range(currentPosition, currentPosition)];

    let maxLines = editor.document.lineCount;
    let config_size: number = getSize();
    let start_cline: number = currentPosition.line - config_size + 1;
    let end_cline: number = currentPosition.line + config_size + 1;

    if (start_cline <= 0) {
        start_cline = 0;
    }

    if (end_cline > maxLines) {
        end_cline = maxLines;
    }

    let prevChar = currentPosition.character > 0 ? currentPosition.character - 1 : 0;
    const documentUri = editor.document.uri.toString();
    const newAddedSpaces: AddedSpaces[] = [];

    try {
        for (let p = start_cline; p < end_cline; p++) {
            if (p > maxLines) {
                break;
            }
            let cline = editor.document.lineAt(p);
            let clineText = cline.text;
            if (clineText.indexOf("\t") !== -1) {
                let autoTabToSpaces = await getAutoTabToSpaces();
                if (!autoTabToSpaces) {
                    isActive = false;
                    window.showInformationMessage("Crosshair: Tabs found in document, extension is disabled");
                    return;
                }
                await commands.executeCommand('editor.action.indentationToSpaces');
                p = start_cline; // reset loop
                isActive = true;
            }
        }
    }
    catch (e) {
        console.log("crosshair tabconvert", e);
    }

    await editor.edit(async edit => {
        try {
            for (let p = start_cline; p < end_cline; p++) {
                if (p > maxLines) {
                    break;
                }
                let cline = editor.document.lineAt(p);
                let clineText = cline.text;
                let missing = currentPosition.character - clineText.length;

                // Only add whitespace if the configuration allows it
                if (shouldAddWhitespace && missing > 0) {
                    let c = 0;
                    let s = "";
                    for (c = 0; c < missing; c++) {
                        s += " ";
                    }

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
    
    // Apply decorations after text edits are complete
    // This ensures positions are calculated with updated line lengths
    for (let p = start_cline; p < end_cline; p++) {
        if (p > maxLines) {
            break;
        }
        let cline = editor.document.lineAt(p);
        
        // Calculate decoration position - use the cursor column consistently
        let columnPos = new Position(p, currentPosition.character);
        newDecorationsLines.push(new Range(columnPos, columnPos));
    }
        
    // Store the tracking information for this document only if we're adding whitespace
    if (shouldAddWhitespace) {
        addedSpacesMap.set(documentUri, newAddedSpaces);
    }
    
    editor.setDecorations(decorationType, newDecorations);
    editor.setDecorations(decorationTypeBlock, newDecorationsLines);
}


function updateDecorations(activeTextEditor: TextEditor,
    decorationType: TextEditorDecorationType,
    decorationTypeBlock: TextEditorDecorationType,
    updateAllVisibleEditors = false) {

    if (!isActive) {
        const newDecorations: Range[] = [];
        const newDecorationsLines: Range[] = [];
        activeTextEditor.setDecorations(decorationType, newDecorations);
        activeTextEditor.setDecorations(decorationTypeBlock, newDecorationsLines);
        
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

    let decorationTypeBlock = getDecorationTypeCursorFromConfig();
    let decorationType = getDecorationTypeFromConfig();

    let timeout: NodeJS.Timeout | undefined = undefined;

    window.onDidChangeActiveTextEditor(() => {
        if (window.activeTextEditor !== undefined) {
            try {
                updateDecorations(window.activeTextEditor, decorationType, decorationTypeBlock);
            } catch (error) {
                console.log("crosshair 'window.onDidChangeActiveTextEditor' -->", error);
            }
        }
    });

    window.onDidChangeTextEditorSelection(() => {
        if (window.activeTextEditor !== undefined) {
            updateDecorations(window.activeTextEditor, decorationType, decorationTypeBlock);
        }
    });

    workspace.onDidChangeTextDocument(event => {
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
                                             decorationType, decorationTypeBlock);
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

    let activeEditor = window.activeTextEditor;

    function updateDecorationsTimer() {
        if (!activeEditor) {
            return;
        }
        updateDecorations(activeEditor, decorationType, decorationTypeBlock);
    }

    function triggerUpdateDecorations() {
        if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
        }
        timeout = setTimeout(updateDecorationsTimer, getRefreshRate());
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
    
    // Clear all tracking data
    addedSpacesMap.clear();
    savedCursorPositions.clear();
}
