'use strict';

import {
    window, workspace, DecorationRangeBehavior,
    TextEditorDecorationType, ExtensionContext,
    Position, Range,
    TextEditor,
    StatusBarItem,
    StatusBarAlignment,
    commands,
    ConfigurationTarget
} from 'vscode';

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
        borderWidth: `0 ${borderWidth} 0 0`,
        borderColor: `${borderColor}`
    });

    return decorationType;
}

function updateDecorationsOnEditor(editor: TextEditor, currentPosition: Position,
    decorationType: TextEditorDecorationType,
    decorationTypeBlock: TextEditorDecorationType) {

    const newDecorations = [new Range(currentPosition, currentPosition)];
    const newDecorationsLines = [new Range(currentPosition, currentPosition)];

    let maxLines = editor.document.lineCount;
    let start_cline: number = currentPosition.line;
    let end_cline = start_cline;
    let config_size = getSize();
    if (start_cline > config_size) {
        start_cline -= config_size;
    }

    if (start_cline < 0) {
        start_cline = 0;
    }

    end_cline += config_size;
    if (end_cline > maxLines) {
        end_cline = maxLines;
    }

    let prevChar = currentPosition.character > 0 ? currentPosition.character - 1 : 0;

    editor.edit(edit => {
        try {
            for (let p = start_cline; p < end_cline; p++) {
                if (p > maxLines || p === 0) {
                    break;
                }
                let cline = editor.document.lineAt(p);
                let missing = currentPosition.character - cline.text.length;

                if (missing > 0) {
                    let c = 0;
                    let s = "";
                    for (c = 0; c < missing; c++) {
                        s += " ";
                    }

                    edit.insert(new Position(p, cline.text.length), s);
                }
                let pos = new Position(p, prevChar);
                let currentPos = new Position(p, currentPosition.character);
                newDecorationsLines.push(new Range(pos, currentPos));
            }
        }
        catch(e) {
            console.log("crosshair space filler",e);
        }
        editor.setDecorations(decorationType, newDecorations);
        editor.setDecorations(decorationTypeBlock, newDecorationsLines);

    });
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
        window.showTextDocument(activeTextEditor.document);
        return;
    }
    try {
        if (updateAllVisibleEditors) {
            window.visibleTextEditors.forEach((editor) => {
                updateDecorationsOnEditor(activeTextEditor, activeTextEditor.selection.active, decorationType, decorationTypeBlock);
            });
        }

        else {
            window.visibleTextEditors.forEach((editor) => {
                if (editor !== window.activeTextEditor) {
                    return;
                }
                updateDecorationsOnEditor(activeTextEditor, activeTextEditor.selection.active, decorationType, decorationTypeBlock);
            });
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

    let timeout: NodeJS.Timer | undefined = undefined;

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
export function deactivate() {
}