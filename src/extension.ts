'use strict';


import {
    window, workspace, DecorationRangeBehavior,
    TextEditorDecorationType, ExtensionContext,
    Position, Range,
    TextEditor,
} from 'vscode';


function getDecorationTypeFromConfig(): TextEditorDecorationType {
    const config = workspace.getConfiguration("crosshair");
    const borderColor = config.get("borderColor");
    const borderWidth = config.get("borderWidth");
    const decorationType = window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: `0 0 ${borderWidth} 0`,
        borderStyle: 'solid',
        rangeBehavior: DecorationRangeBehavior.ClosedClosed,
        borderColor
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
        borderColor
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
    if (start_cline > 10) {
        start_cline -= 10;
    }

    if (start_cline < 0) {
        start_cline = 0;
    }
    end_cline += 10;
    if (end_cline > maxLines) {
        end_cline = maxLines;
    }
    let prevChar = currentPosition.character > 0 ? currentPosition.character - 1 : 0;
    for (let p = start_cline; p < end_cline; p++) {
        if (p > maxLines || p === 0) {
            break;
        }
        let cline = editor.document.lineAt(p);
        let missing =  currentPosition.character - cline.text.length;

         if (missing > 0) {
             let c=0;
             let s="";
             for(c=0; c<missing; c++) {
                s += " ";
             }
             editor.edit(edit => {
                    edit.insert(new Position(p,cline.text.length), s);
                  }
                );
            
            //  let theend = TextEdit.insert(new Position(p, cline.text.length),s);
            //  editor.edit()

         }
        let pos = new Position(p, prevChar);
        let currentPos = new Position(p, currentPosition.character);
        newDecorationsLines.push(new Range(pos, currentPos));
    }
    editor.setDecorations(decorationType, newDecorations);
    editor.setDecorations(decorationTypeBlock, newDecorationsLines);
}


function updateDecorations(activeTextEditor: TextEditor,
    decorationType: TextEditorDecorationType,
    decorationTypeBlock: TextEditorDecorationType,
    updateAllVisibleEditors = false) {
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
        console.error("Error from ' updateDecorations' -->", error);
    } finally {
        return new Position(activeTextEditor.selection.active.line, activeTextEditor.selection.active.character);
    }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {

    let decorationTypeBlock = getDecorationTypeCursorFromConfig();
    let decorationType = getDecorationTypeFromConfig();

    window.onDidChangeActiveTextEditor(() => {
        if (window.activeTextEditor !== undefined) {
            try {
                updateDecorations(window.activeTextEditor, decorationType, decorationTypeBlock);
            } catch (error) {
                console.error("Error from ' window.onDidChangeActiveTextEditor' -->", error);
            }
        }
    });

    window.onDidChangeTextEditorSelection(() => {
        if (window.activeTextEditor !== undefined) {
            updateDecorations(window.activeTextEditor, decorationType, decorationTypeBlock);
        }
    });
}

// this method is called when your extension is deactivated
export function deactivate() {
}