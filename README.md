# vscode-crosshair README

Displays both a horizontal and vertical ruler at the cursor position

## Features

Shows a crosshair simular to the one you get using a ISPF editor on the mainframe.

## Configuration

### Whitespace Handling

The extension provides a configurable option for how it handles short lines:

- **`crosshair.addWhitespace`** (default: `true`): Controls whether the extension adds whitespace to extend short lines for crosshair display.
  - When **enabled**: Allows crosshair to extend beyond line endings and enables block selection (Alt+Shift+drag) beyond line ends, but temporarily modifies file content with spaces.
  - When **disabled**: Crosshair stops at the actual line end, preserving file content but limiting block selection capabilities.

### Other Settings

- **`crosshair.enabled`**: Enable or disable the crosshair extension
- **`crosshair.borderColor`**: Change the border color
- **`crosshair.size`**: Size of crosshair
- **`crosshair.refreshRate`**: Crosshair refresh rate in ms
- **`crosshair.autoTabToSpace`**: Automatically convert tabs to spaces

## Toggle

You can easily toggle the cursor on/off!

![Alt text](/images/showtoggle.png)

**Enjoy!**
