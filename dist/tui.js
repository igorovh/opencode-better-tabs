// @bun
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { existsSync as existsSync2 } from "fs";
import path2 from "path";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import { Portal } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

function createScanner(text, ignoreTrivia = false) {
  const len = text.length;
  let pos = 0, value = "", tokenOffset = 0, token = 16, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0;
  function scanHexDigits(count, exact) {
    let digits = 0;
    let value = 0;
    while (digits < count || !exact) {
      let ch = text.charCodeAt(pos);
      if (ch >= 48 && ch <= 57) {
        value = value * 16 + ch - 48;
      } else if (ch >= 65 && ch <= 70) {
        value = value * 16 + ch - 65 + 10;
      } else if (ch >= 97 && ch <= 102) {
        value = value * 16 + ch - 97 + 10;
      } else {
        break;
      }
      pos++;
      digits++;
    }
    if (digits < count) {
      value = -1;
    }
    return value;
  }
  function setPosition(newPosition) {
    pos = newPosition;
    value = "";
    tokenOffset = 0;
    token = 16;
    scanError = 0;
  }
  function scanNumber() {
    let start = pos;
    if (text.charCodeAt(pos) === 48) {
      pos++;
    } else {
      pos++;
      while (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
      }
    }
    if (pos < text.length && text.charCodeAt(pos) === 46) {
      pos++;
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
      } else {
        scanError = 3;
        return text.substring(start, pos);
      }
    }
    let end = pos;
    if (pos < text.length && (text.charCodeAt(pos) === 69 || text.charCodeAt(pos) === 101)) {
      pos++;
      if (pos < text.length && text.charCodeAt(pos) === 43 || text.charCodeAt(pos) === 45) {
        pos++;
      }
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
        end = pos;
      } else {
        scanError = 3;
      }
    }
    return text.substring(start, end);
  }
  function scanString() {
    let result = "", start = pos;
    while (true) {
      if (pos >= len) {
        result += text.substring(start, pos);
        scanError = 2;
        break;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 34) {
        result += text.substring(start, pos);
        pos++;
        break;
      }
      if (ch === 92) {
        result += text.substring(start, pos);
        pos++;
        if (pos >= len) {
          scanError = 2;
          break;
        }
        const ch2 = text.charCodeAt(pos++);
        switch (ch2) {
          case 34:
            result += '"';
            break;
          case 92:
            result += "\\";
            break;
          case 47:
            result += "/";
            break;
          case 98:
            result += "\b";
            break;
          case 102:
            result += "\f";
            break;
          case 110:
            result += `
`;
            break;
          case 114:
            result += "\r";
            break;
          case 116:
            result += "\t";
            break;
          case 117:
            const ch3 = scanHexDigits(4, true);
            if (ch3 >= 0) {
              result += String.fromCharCode(ch3);
            } else {
              scanError = 4;
            }
            break;
          default:
            scanError = 5;
        }
        start = pos;
        continue;
      }
      if (ch >= 0 && ch <= 31) {
        if (isLineBreak(ch)) {
          result += text.substring(start, pos);
          scanError = 2;
          break;
        } else {
          scanError = 6;
        }
      }
      pos++;
    }
    return result;
  }
  function scanNext() {
    value = "";
    scanError = 0;
    tokenOffset = pos;
    lineStartOffset = lineNumber;
    prevTokenLineStartOffset = tokenLineStartOffset;
    if (pos >= len) {
      tokenOffset = len;
      return token = 17;
    }
    let code = text.charCodeAt(pos);
    if (isWhiteSpace(code)) {
      do {
        pos++;
        value += String.fromCharCode(code);
        code = text.charCodeAt(pos);
      } while (isWhiteSpace(code));
      return token = 15;
    }
    if (isLineBreak(code)) {
      pos++;
      value += String.fromCharCode(code);
      if (code === 13 && text.charCodeAt(pos) === 10) {
        pos++;
        value += `
`;
      }
      lineNumber++;
      tokenLineStartOffset = pos;
      return token = 14;
    }
    switch (code) {
      case 123:
        pos++;
        return token = 1;
      case 125:
        pos++;
        return token = 2;
      case 91:
        pos++;
        return token = 3;
      case 93:
        pos++;
        return token = 4;
      case 58:
        pos++;
        return token = 6;
      case 44:
        pos++;
        return token = 5;
      case 34:
        pos++;
        value = scanString();
        return token = 10;
      case 47:
        const start = pos - 1;
        if (text.charCodeAt(pos + 1) === 47) {
          pos += 2;
          while (pos < len) {
            if (isLineBreak(text.charCodeAt(pos))) {
              break;
            }
            pos++;
          }
          value = text.substring(start, pos);
          return token = 12;
        }
        if (text.charCodeAt(pos + 1) === 42) {
          pos += 2;
          const safeLength = len - 1;
          let commentClosed = false;
          while (pos < safeLength) {
            const ch = text.charCodeAt(pos);
            if (ch === 42 && text.charCodeAt(pos + 1) === 47) {
              pos += 2;
              commentClosed = true;
              break;
            }
            pos++;
            if (isLineBreak(ch)) {
              if (ch === 13 && text.charCodeAt(pos) === 10) {
                pos++;
              }
              lineNumber++;
              tokenLineStartOffset = pos;
            }
          }
          if (!commentClosed) {
            pos++;
            scanError = 1;
          }
          value = text.substring(start, pos);
          return token = 13;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
      case 45:
        value += String.fromCharCode(code);
        pos++;
        if (pos === len || !isDigit(text.charCodeAt(pos))) {
          return token = 16;
        }
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        value += scanNumber();
        return token = 11;
      default:
        while (pos < len && isUnknownContentCharacter(code)) {
          pos++;
          code = text.charCodeAt(pos);
        }
        if (tokenOffset !== pos) {
          value = text.substring(tokenOffset, pos);
          switch (value) {
            case "true":
              return token = 8;
            case "false":
              return token = 9;
            case "null":
              return token = 7;
          }
          return token = 16;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
    }
  }
  function isUnknownContentCharacter(code) {
    if (isWhiteSpace(code) || isLineBreak(code)) {
      return false;
    }
    switch (code) {
      case 125:
      case 93:
      case 123:
      case 91:
      case 34:
      case 58:
      case 44:
      case 47:
        return false;
    }
    return true;
  }
  function scanNextNonTrivia() {
    let result;
    do {
      result = scanNext();
    } while (result >= 12 && result <= 15);
    return result;
  }
  return {
    setPosition,
    getPosition: () => pos,
    scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
    getToken: () => token,
    getTokenValue: () => value,
    getTokenOffset: () => tokenOffset,
    getTokenLength: () => pos - tokenOffset,
    getTokenStartLine: () => lineStartOffset,
    getTokenStartCharacter: () => tokenOffset - prevTokenLineStartOffset,
    getTokenError: () => scanError
  };
}
function isWhiteSpace(ch) {
  return ch === 32 || ch === 9;
}
function isLineBreak(ch) {
  return ch === 10 || ch === 13;
}
function isDigit(ch) {
  return ch >= 48 && ch <= 57;
}
var CharacterCodes;
(function(CharacterCodes) {
  CharacterCodes[CharacterCodes["lineFeed"] = 10] = "lineFeed";
  CharacterCodes[CharacterCodes["carriageReturn"] = 13] = "carriageReturn";
  CharacterCodes[CharacterCodes["space"] = 32] = "space";
  CharacterCodes[CharacterCodes["_0"] = 48] = "_0";
  CharacterCodes[CharacterCodes["_1"] = 49] = "_1";
  CharacterCodes[CharacterCodes["_2"] = 50] = "_2";
  CharacterCodes[CharacterCodes["_3"] = 51] = "_3";
  CharacterCodes[CharacterCodes["_4"] = 52] = "_4";
  CharacterCodes[CharacterCodes["_5"] = 53] = "_5";
  CharacterCodes[CharacterCodes["_6"] = 54] = "_6";
  CharacterCodes[CharacterCodes["_7"] = 55] = "_7";
  CharacterCodes[CharacterCodes["_8"] = 56] = "_8";
  CharacterCodes[CharacterCodes["_9"] = 57] = "_9";
  CharacterCodes[CharacterCodes["a"] = 97] = "a";
  CharacterCodes[CharacterCodes["b"] = 98] = "b";
  CharacterCodes[CharacterCodes["c"] = 99] = "c";
  CharacterCodes[CharacterCodes["d"] = 100] = "d";
  CharacterCodes[CharacterCodes["e"] = 101] = "e";
  CharacterCodes[CharacterCodes["f"] = 102] = "f";
  CharacterCodes[CharacterCodes["g"] = 103] = "g";
  CharacterCodes[CharacterCodes["h"] = 104] = "h";
  CharacterCodes[CharacterCodes["i"] = 105] = "i";
  CharacterCodes[CharacterCodes["j"] = 106] = "j";
  CharacterCodes[CharacterCodes["k"] = 107] = "k";
  CharacterCodes[CharacterCodes["l"] = 108] = "l";
  CharacterCodes[CharacterCodes["m"] = 109] = "m";
  CharacterCodes[CharacterCodes["n"] = 110] = "n";
  CharacterCodes[CharacterCodes["o"] = 111] = "o";
  CharacterCodes[CharacterCodes["p"] = 112] = "p";
  CharacterCodes[CharacterCodes["q"] = 113] = "q";
  CharacterCodes[CharacterCodes["r"] = 114] = "r";
  CharacterCodes[CharacterCodes["s"] = 115] = "s";
  CharacterCodes[CharacterCodes["t"] = 116] = "t";
  CharacterCodes[CharacterCodes["u"] = 117] = "u";
  CharacterCodes[CharacterCodes["v"] = 118] = "v";
  CharacterCodes[CharacterCodes["w"] = 119] = "w";
  CharacterCodes[CharacterCodes["x"] = 120] = "x";
  CharacterCodes[CharacterCodes["y"] = 121] = "y";
  CharacterCodes[CharacterCodes["z"] = 122] = "z";
  CharacterCodes[CharacterCodes["A"] = 65] = "A";
  CharacterCodes[CharacterCodes["B"] = 66] = "B";
  CharacterCodes[CharacterCodes["C"] = 67] = "C";
  CharacterCodes[CharacterCodes["D"] = 68] = "D";
  CharacterCodes[CharacterCodes["E"] = 69] = "E";
  CharacterCodes[CharacterCodes["F"] = 70] = "F";
  CharacterCodes[CharacterCodes["G"] = 71] = "G";
  CharacterCodes[CharacterCodes["H"] = 72] = "H";
  CharacterCodes[CharacterCodes["I"] = 73] = "I";
  CharacterCodes[CharacterCodes["J"] = 74] = "J";
  CharacterCodes[CharacterCodes["K"] = 75] = "K";
  CharacterCodes[CharacterCodes["L"] = 76] = "L";
  CharacterCodes[CharacterCodes["M"] = 77] = "M";
  CharacterCodes[CharacterCodes["N"] = 78] = "N";
  CharacterCodes[CharacterCodes["O"] = 79] = "O";
  CharacterCodes[CharacterCodes["P"] = 80] = "P";
  CharacterCodes[CharacterCodes["Q"] = 81] = "Q";
  CharacterCodes[CharacterCodes["R"] = 82] = "R";
  CharacterCodes[CharacterCodes["S"] = 83] = "S";
  CharacterCodes[CharacterCodes["T"] = 84] = "T";
  CharacterCodes[CharacterCodes["U"] = 85] = "U";
  CharacterCodes[CharacterCodes["V"] = 86] = "V";
  CharacterCodes[CharacterCodes["W"] = 87] = "W";
  CharacterCodes[CharacterCodes["X"] = 88] = "X";
  CharacterCodes[CharacterCodes["Y"] = 89] = "Y";
  CharacterCodes[CharacterCodes["Z"] = 90] = "Z";
  CharacterCodes[CharacterCodes["asterisk"] = 42] = "asterisk";
  CharacterCodes[CharacterCodes["backslash"] = 92] = "backslash";
  CharacterCodes[CharacterCodes["closeBrace"] = 125] = "closeBrace";
  CharacterCodes[CharacterCodes["closeBracket"] = 93] = "closeBracket";
  CharacterCodes[CharacterCodes["colon"] = 58] = "colon";
  CharacterCodes[CharacterCodes["comma"] = 44] = "comma";
  CharacterCodes[CharacterCodes["dot"] = 46] = "dot";
  CharacterCodes[CharacterCodes["doubleQuote"] = 34] = "doubleQuote";
  CharacterCodes[CharacterCodes["minus"] = 45] = "minus";
  CharacterCodes[CharacterCodes["openBrace"] = 123] = "openBrace";
  CharacterCodes[CharacterCodes["openBracket"] = 91] = "openBracket";
  CharacterCodes[CharacterCodes["plus"] = 43] = "plus";
  CharacterCodes[CharacterCodes["slash"] = 47] = "slash";
  CharacterCodes[CharacterCodes["formFeed"] = 12] = "formFeed";
  CharacterCodes[CharacterCodes["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));

var cachedSpaces = new Array(20).fill(0).map((_, index) => {
  return " ".repeat(index);
});
var maxCachedValues = 200;
var cachedBreakLinesWithSpaces = {
  " ": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `
` + " ".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + " ".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `\r
` + " ".repeat(index);
    })
  },
  "\t": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `
` + "\t".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + "\t".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `\r
` + "\t".repeat(index);
    })
  }
};
var supportedEols = [`
`, "\r", `\r
`];

function format(documentText, range, options) {
  let initialIndentLevel;
  let formatText;
  let formatTextStart;
  let rangeStart;
  let rangeEnd;
  if (range) {
    rangeStart = range.offset;
    rangeEnd = rangeStart + range.length;
    formatTextStart = rangeStart;
    while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) {
      formatTextStart--;
    }
    let endOffset = rangeEnd;
    while (endOffset < documentText.length && !isEOL(documentText, endOffset)) {
      endOffset++;
    }
    formatText = documentText.substring(formatTextStart, endOffset);
    initialIndentLevel = computeIndentLevel(formatText, options);
  } else {
    formatText = documentText;
    initialIndentLevel = 0;
    formatTextStart = 0;
    rangeStart = 0;
    rangeEnd = documentText.length;
  }
  const eol = getEOL(options, documentText);
  const eolFastPathSupported = supportedEols.includes(eol);
  let numberLineBreaks = 0;
  let indentLevel = 0;
  let indentValue;
  if (options.insertSpaces) {
    indentValue = cachedSpaces[options.tabSize || 4] ?? repeat(cachedSpaces[1], options.tabSize || 4);
  } else {
    indentValue = "\t";
  }
  const indentType = indentValue === "\t" ? "\t" : " ";
  let scanner = createScanner(formatText, false);
  let hasError = false;
  function newLinesAndIndent() {
    if (numberLineBreaks > 1) {
      return repeat(eol, numberLineBreaks) + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    const amountOfSpaces = indentValue.length * (initialIndentLevel + indentLevel);
    if (!eolFastPathSupported || amountOfSpaces > cachedBreakLinesWithSpaces[indentType][eol].length) {
      return eol + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    if (amountOfSpaces <= 0) {
      return eol;
    }
    return cachedBreakLinesWithSpaces[indentType][eol][amountOfSpaces];
  }
  function scanNext() {
    let token = scanner.scan();
    numberLineBreaks = 0;
    while (token === 15 || token === 14) {
      if (token === 14 && options.keepLines) {
        numberLineBreaks += 1;
      } else if (token === 14) {
        numberLineBreaks = 1;
      }
      token = scanner.scan();
    }
    hasError = token === 16 || scanner.getTokenError() !== 0;
    return token;
  }
  const editOperations = [];
  function addEdit(text, startOffset, endOffset) {
    if (!hasError && (!range || startOffset < rangeEnd && endOffset > rangeStart) && documentText.substring(startOffset, endOffset) !== text) {
      editOperations.push({ offset: startOffset, length: endOffset - startOffset, content: text });
    }
  }
  let firstToken = scanNext();
  if (options.keepLines && numberLineBreaks > 0) {
    addEdit(repeat(eol, numberLineBreaks), 0, 0);
  }
  if (firstToken !== 17) {
    let firstTokenStart = scanner.getTokenOffset() + formatTextStart;
    let initialIndent = indentValue.length * initialIndentLevel < 20 && options.insertSpaces ? cachedSpaces[indentValue.length * initialIndentLevel] : repeat(indentValue, initialIndentLevel);
    addEdit(initialIndent, formatTextStart, firstTokenStart);
  }
  while (firstToken !== 17) {
    let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
    let secondToken = scanNext();
    let replaceContent = "";
    let needsLineBreak = false;
    while (numberLineBreaks === 0 && (secondToken === 12 || secondToken === 13)) {
      let commentTokenStart = scanner.getTokenOffset() + formatTextStart;
      addEdit(cachedSpaces[1], firstTokenEnd, commentTokenStart);
      firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
      needsLineBreak = secondToken === 12;
      replaceContent = needsLineBreak ? newLinesAndIndent() : "";
      secondToken = scanNext();
    }
    if (secondToken === 2) {
      if (firstToken !== 1) {
        indentLevel--;
      }
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 1) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else if (secondToken === 4) {
      if (firstToken !== 3) {
        indentLevel--;
      }
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 3) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else {
      switch (firstToken) {
        case 3:
        case 1:
          indentLevel++;
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 5:
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 12:
          replaceContent = newLinesAndIndent();
          break;
        case 13:
          if (numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 6:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 10:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (secondToken === 6 && !needsLineBreak) {
            replaceContent = "";
          }
          break;
        case 7:
        case 8:
        case 9:
        case 11:
        case 2:
        case 4:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else {
            if ((secondToken === 12 || secondToken === 13) && !needsLineBreak) {
              replaceContent = cachedSpaces[1];
            } else if (secondToken !== 5 && secondToken !== 17) {
              hasError = true;
            }
          }
          break;
        case 16:
          hasError = true;
          break;
      }
      if (numberLineBreaks > 0 && (secondToken === 12 || secondToken === 13)) {
        replaceContent = newLinesAndIndent();
      }
    }
    if (secondToken === 17) {
      if (options.keepLines && numberLineBreaks > 0) {
        replaceContent = newLinesAndIndent();
      } else {
        replaceContent = options.insertFinalNewline ? eol : "";
      }
    }
    const secondTokenStart = scanner.getTokenOffset() + formatTextStart;
    addEdit(replaceContent, firstTokenEnd, secondTokenStart);
    firstToken = secondToken;
  }
  return editOperations;
}
function repeat(s, count) {
  let result = "";
  for (let i = 0;i < count; i++) {
    result += s;
  }
  return result;
}
function computeIndentLevel(content, options) {
  let i = 0;
  let nChars = 0;
  const tabSize = options.tabSize || 4;
  while (i < content.length) {
    let ch = content.charAt(i);
    if (ch === cachedSpaces[1]) {
      nChars++;
    } else if (ch === "\t") {
      nChars += tabSize;
    } else {
      break;
    }
    i++;
  }
  return Math.floor(nChars / tabSize);
}
function getEOL(options, text) {
  for (let i = 0;i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\r") {
      if (i + 1 < text.length && text.charAt(i + 1) === `
`) {
        return `\r
`;
      }
      return "\r";
    } else if (ch === `
`) {
      return `
`;
    }
  }
  return options && options.eol || `
`;
}
function isEOL(text, offset) {
  return `\r
`.indexOf(text.charAt(offset)) !== -1;
}

var ParseOptions;
(function(ParseOptions) {
  ParseOptions.DEFAULT = {
    allowTrailingComma: false
  };
})(ParseOptions || (ParseOptions = {}));
function parse(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentProperty = null;
  let currentParent = [];
  const previousParents = [];
  function onValue(value) {
    if (Array.isArray(currentParent)) {
      currentParent.push(value);
    } else if (currentProperty !== null) {
      currentParent[currentProperty] = value;
    }
  }
  const visitor = {
    onObjectBegin: () => {
      const object = {};
      onValue(object);
      previousParents.push(currentParent);
      currentParent = object;
      currentProperty = null;
    },
    onObjectProperty: (name) => {
      currentProperty = name;
    },
    onObjectEnd: () => {
      currentParent = previousParents.pop();
    },
    onArrayBegin: () => {
      const array = [];
      onValue(array);
      previousParents.push(currentParent);
      currentParent = array;
      currentProperty = null;
    },
    onArrayEnd: () => {
      currentParent = previousParents.pop();
    },
    onLiteralValue: onValue,
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  return currentParent[0];
}
function parseTree(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentParent = { type: "array", offset: -1, length: -1, children: [], parent: undefined };
  function ensurePropertyComplete(endOffset) {
    if (currentParent.type === "property") {
      currentParent.length = endOffset - currentParent.offset;
      currentParent = currentParent.parent;
    }
  }
  function onValue(valueNode) {
    currentParent.children.push(valueNode);
    return valueNode;
  }
  const visitor = {
    onObjectBegin: (offset) => {
      currentParent = onValue({ type: "object", offset, length: -1, parent: currentParent, children: [] });
    },
    onObjectProperty: (name, offset, length) => {
      currentParent = onValue({ type: "property", offset, length: -1, parent: currentParent, children: [] });
      currentParent.children.push({ type: "string", value: name, offset, length, parent: currentParent });
    },
    onObjectEnd: (offset, length) => {
      ensurePropertyComplete(offset + length);
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    },
    onArrayBegin: (offset, length) => {
      currentParent = onValue({ type: "array", offset, length: -1, parent: currentParent, children: [] });
    },
    onArrayEnd: (offset, length) => {
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    },
    onLiteralValue: (value, offset, length) => {
      onValue({ type: getNodeType(value), offset, length, parent: currentParent, value });
      ensurePropertyComplete(offset + length);
    },
    onSeparator: (sep, offset, length) => {
      if (currentParent.type === "property") {
        if (sep === ":") {
          currentParent.colonOffset = offset;
        } else if (sep === ",") {
          ensurePropertyComplete(offset);
        }
      }
    },
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  const result = currentParent.children[0];
  if (result) {
    delete result.parent;
  }
  return result;
}
function findNodeAtLocation(root, path) {
  if (!root) {
    return;
  }
  let node = root;
  for (let segment of path) {
    if (typeof segment === "string") {
      if (node.type !== "object" || !Array.isArray(node.children)) {
        return;
      }
      let found = false;
      for (const propertyNode of node.children) {
        if (Array.isArray(propertyNode.children) && propertyNode.children[0].value === segment && propertyNode.children.length === 2) {
          node = propertyNode.children[1];
          found = true;
          break;
        }
      }
      if (!found) {
        return;
      }
    } else {
      const index = segment;
      if (node.type !== "array" || index < 0 || !Array.isArray(node.children) || index >= node.children.length) {
        return;
      }
      node = node.children[index];
    }
  }
  return node;
}
function visit(text, visitor, options = ParseOptions.DEFAULT) {
  const _scanner = createScanner(text, false);
  const _jsonPath = [];
  let suppressedCallbacks = 0;
  function toNoArgVisit(visitFunction) {
    return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisit(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisitWithPath(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
  }
  function toBeginVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks++;
      } else {
        let cbReturn = visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice());
        if (cbReturn === false) {
          suppressedCallbacks = 1;
        }
      }
    } : () => true;
  }
  function toEndVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks--;
      }
      if (suppressedCallbacks === 0) {
        visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
      }
    } : () => true;
  }
  const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
  const disallowComments = options && options.disallowComments;
  const allowTrailingComma = options && options.allowTrailingComma;
  function scanNext() {
    while (true) {
      const token = _scanner.scan();
      switch (_scanner.getTokenError()) {
        case 4:
          handleError(14);
          break;
        case 5:
          handleError(15);
          break;
        case 3:
          handleError(13);
          break;
        case 1:
          if (!disallowComments) {
            handleError(11);
          }
          break;
        case 2:
          handleError(12);
          break;
        case 6:
          handleError(16);
          break;
      }
      switch (token) {
        case 12:
        case 13:
          if (disallowComments) {
            handleError(10);
          } else {
            onComment();
          }
          break;
        case 16:
          handleError(1);
          break;
        case 15:
        case 14:
          break;
        default:
          return token;
      }
    }
  }
  function handleError(error, skipUntilAfter = [], skipUntil = []) {
    onError(error);
    if (skipUntilAfter.length + skipUntil.length > 0) {
      let token = _scanner.getToken();
      while (token !== 17) {
        if (skipUntilAfter.indexOf(token) !== -1) {
          scanNext();
          break;
        } else if (skipUntil.indexOf(token) !== -1) {
          break;
        }
        token = scanNext();
      }
    }
  }
  function parseString(isValue) {
    const value = _scanner.getTokenValue();
    if (isValue) {
      onLiteralValue(value);
    } else {
      onObjectProperty(value);
      _jsonPath.push(value);
    }
    scanNext();
    return true;
  }
  function parseLiteral() {
    switch (_scanner.getToken()) {
      case 11:
        const tokenValue = _scanner.getTokenValue();
        let value = Number(tokenValue);
        if (isNaN(value)) {
          handleError(2);
          value = 0;
        }
        onLiteralValue(value);
        break;
      case 7:
        onLiteralValue(null);
        break;
      case 8:
        onLiteralValue(true);
        break;
      case 9:
        onLiteralValue(false);
        break;
      default:
        return false;
    }
    scanNext();
    return true;
  }
  function parseProperty() {
    if (_scanner.getToken() !== 10) {
      handleError(3, [], [2, 5]);
      return false;
    }
    parseString(false);
    if (_scanner.getToken() === 6) {
      onSeparator(":");
      scanNext();
      if (!parseValue()) {
        handleError(4, [], [2, 5]);
      }
    } else {
      handleError(5, [], [2, 5]);
    }
    _jsonPath.pop();
    return true;
  }
  function parseObject() {
    onObjectBegin();
    scanNext();
    let needsComma = false;
    while (_scanner.getToken() !== 2 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 2 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (!parseProperty()) {
        handleError(4, [], [2, 5]);
      }
      needsComma = true;
    }
    onObjectEnd();
    if (_scanner.getToken() !== 2) {
      handleError(7, [2], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseArray() {
    onArrayBegin();
    scanNext();
    let isFirstElement = true;
    let needsComma = false;
    while (_scanner.getToken() !== 4 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 4 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (isFirstElement) {
        _jsonPath.push(0);
        isFirstElement = false;
      } else {
        _jsonPath[_jsonPath.length - 1]++;
      }
      if (!parseValue()) {
        handleError(4, [], [4, 5]);
      }
      needsComma = true;
    }
    onArrayEnd();
    if (!isFirstElement) {
      _jsonPath.pop();
    }
    if (_scanner.getToken() !== 4) {
      handleError(8, [4], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseValue() {
    switch (_scanner.getToken()) {
      case 3:
        return parseArray();
      case 1:
        return parseObject();
      case 10:
        return parseString(true);
      default:
        return parseLiteral();
    }
  }
  scanNext();
  if (_scanner.getToken() === 17) {
    if (options.allowEmptyContent) {
      return true;
    }
    handleError(4, [], []);
    return false;
  }
  if (!parseValue()) {
    handleError(4, [], []);
    return false;
  }
  if (_scanner.getToken() !== 17) {
    handleError(9, [], []);
  }
  return true;
}
function getNodeType(value) {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object": {
      if (!value) {
        return "null";
      } else if (Array.isArray(value)) {
        return "array";
      }
      return "object";
    }
    default:
      return "null";
  }
}

function setProperty(text, originalPath, value, options) {
  const path = originalPath.slice();
  const errors = [];
  const root = parseTree(text, errors);
  let parent = undefined;
  let lastSegment = undefined;
  while (path.length > 0) {
    lastSegment = path.pop();
    parent = findNodeAtLocation(root, path);
    if (parent === undefined && value !== undefined) {
      if (typeof lastSegment === "string") {
        value = { [lastSegment]: value };
      } else {
        value = [value];
      }
    } else {
      break;
    }
  }
  if (!parent) {
    if (value === undefined) {
      throw new Error("Can not delete in empty document");
    }
    return withFormatting(text, { offset: root ? root.offset : 0, length: root ? root.length : 0, content: JSON.stringify(value) }, options);
  } else if (parent.type === "object" && typeof lastSegment === "string" && Array.isArray(parent.children)) {
    const existing = findNodeAtLocation(parent, [lastSegment]);
    if (existing !== undefined) {
      if (value === undefined) {
        if (!existing.parent) {
          throw new Error("Malformed AST");
        }
        const propertyIndex = parent.children.indexOf(existing.parent);
        let removeBegin;
        let removeEnd = existing.parent.offset + existing.parent.length;
        if (propertyIndex > 0) {
          let previous = parent.children[propertyIndex - 1];
          removeBegin = previous.offset + previous.length;
        } else {
          removeBegin = parent.offset + 1;
          if (parent.children.length > 1) {
            let next = parent.children[1];
            removeEnd = next.offset;
          }
        }
        return withFormatting(text, { offset: removeBegin, length: removeEnd - removeBegin, content: "" }, options);
      } else {
        return withFormatting(text, { offset: existing.offset, length: existing.length, content: JSON.stringify(value) }, options);
      }
    } else {
      if (value === undefined) {
        return [];
      }
      const newProperty = `${JSON.stringify(lastSegment)}: ${JSON.stringify(value)}`;
      const index = options.getInsertionIndex ? options.getInsertionIndex(parent.children.map((p) => p.children[0].value)) : parent.children.length;
      let edit;
      if (index > 0) {
        let previous = parent.children[index - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      } else if (parent.children.length === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty + "," };
      }
      return withFormatting(text, edit, options);
    }
  } else if (parent.type === "array" && typeof lastSegment === "number" && Array.isArray(parent.children)) {
    const insertIndex = lastSegment;
    if (insertIndex === -1) {
      const newProperty = `${JSON.stringify(value)}`;
      let edit;
      if (parent.children.length === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        const previous = parent.children[parent.children.length - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit, options);
    } else if (value === undefined && parent.children.length >= 0) {
      const removalIndex = lastSegment;
      const toRemove = parent.children[removalIndex];
      let edit;
      if (parent.children.length === 1) {
        edit = { offset: parent.offset + 1, length: parent.length - 2, content: "" };
      } else if (parent.children.length - 1 === removalIndex) {
        let previous = parent.children[removalIndex - 1];
        let offset = previous.offset + previous.length;
        let parentEndOffset = parent.offset + parent.length;
        edit = { offset, length: parentEndOffset - 2 - offset, content: "" };
      } else {
        edit = { offset: toRemove.offset, length: parent.children[removalIndex + 1].offset - toRemove.offset, content: "" };
      }
      return withFormatting(text, edit, options);
    } else if (value !== undefined) {
      let edit;
      const newProperty = `${JSON.stringify(value)}`;
      if (!options.isArrayInsertion && parent.children.length > lastSegment) {
        const toModify = parent.children[lastSegment];
        edit = { offset: toModify.offset, length: toModify.length, content: newProperty };
      } else if (parent.children.length === 0 || lastSegment === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: parent.children.length === 0 ? newProperty : newProperty + "," };
      } else {
        const index = lastSegment > parent.children.length ? parent.children.length : lastSegment;
        const previous = parent.children[index - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit, options);
    } else {
      throw new Error(`Can not ${value === undefined ? "remove" : options.isArrayInsertion ? "insert" : "modify"} Array index ${insertIndex} as length is not sufficient`);
    }
  } else {
    throw new Error(`Can not add ${typeof lastSegment !== "number" ? "index" : "property"} to parent of type ${parent.type}`);
  }
}
function withFormatting(text, edit, options) {
  if (!options.formattingOptions) {
    return [edit];
  }
  let newText = applyEdit(text, edit);
  let begin = edit.offset;
  let end = edit.offset + edit.content.length;
  if (edit.length === 0 || edit.content.length === 0) {
    while (begin > 0 && !isEOL(newText, begin - 1)) {
      begin--;
    }
    while (end < newText.length && !isEOL(newText, end)) {
      end++;
    }
  }
  const edits = format(newText, { offset: begin, length: end - begin }, { ...options.formattingOptions, keepLines: false });
  for (let i = edits.length - 1;i >= 0; i--) {
    const edit = edits[i];
    newText = applyEdit(newText, edit);
    begin = Math.min(begin, edit.offset);
    end = Math.max(end, edit.offset + edit.length);
    end += edit.content.length - edit.length;
  }
  const editLength = text.length - (newText.length - end) - begin;
  return [{ offset: begin, length: editLength, content: newText.substring(begin, end) }];
}
function applyEdit(text, edit) {
  return text.substring(0, edit.offset) + edit.content + text.substring(edit.offset + edit.length);
}

var ScanError;
(function(ScanError) {
  ScanError[ScanError["None"] = 0] = "None";
  ScanError[ScanError["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
  ScanError[ScanError["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
  ScanError[ScanError["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
  ScanError[ScanError["InvalidUnicode"] = 4] = "InvalidUnicode";
  ScanError[ScanError["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
  ScanError[ScanError["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind) {
  SyntaxKind[SyntaxKind["OpenBraceToken"] = 1] = "OpenBraceToken";
  SyntaxKind[SyntaxKind["CloseBraceToken"] = 2] = "CloseBraceToken";
  SyntaxKind[SyntaxKind["OpenBracketToken"] = 3] = "OpenBracketToken";
  SyntaxKind[SyntaxKind["CloseBracketToken"] = 4] = "CloseBracketToken";
  SyntaxKind[SyntaxKind["CommaToken"] = 5] = "CommaToken";
  SyntaxKind[SyntaxKind["ColonToken"] = 6] = "ColonToken";
  SyntaxKind[SyntaxKind["NullKeyword"] = 7] = "NullKeyword";
  SyntaxKind[SyntaxKind["TrueKeyword"] = 8] = "TrueKeyword";
  SyntaxKind[SyntaxKind["FalseKeyword"] = 9] = "FalseKeyword";
  SyntaxKind[SyntaxKind["StringLiteral"] = 10] = "StringLiteral";
  SyntaxKind[SyntaxKind["NumericLiteral"] = 11] = "NumericLiteral";
  SyntaxKind[SyntaxKind["LineCommentTrivia"] = 12] = "LineCommentTrivia";
  SyntaxKind[SyntaxKind["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
  SyntaxKind[SyntaxKind["LineBreakTrivia"] = 14] = "LineBreakTrivia";
  SyntaxKind[SyntaxKind["Trivia"] = 15] = "Trivia";
  SyntaxKind[SyntaxKind["Unknown"] = 16] = "Unknown";
  SyntaxKind[SyntaxKind["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
var parse2 = parse;
var ParseErrorCode;
(function(ParseErrorCode) {
  ParseErrorCode[ParseErrorCode["InvalidSymbol"] = 1] = "InvalidSymbol";
  ParseErrorCode[ParseErrorCode["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
  ParseErrorCode[ParseErrorCode["PropertyNameExpected"] = 3] = "PropertyNameExpected";
  ParseErrorCode[ParseErrorCode["ValueExpected"] = 4] = "ValueExpected";
  ParseErrorCode[ParseErrorCode["ColonExpected"] = 5] = "ColonExpected";
  ParseErrorCode[ParseErrorCode["CommaExpected"] = 6] = "CommaExpected";
  ParseErrorCode[ParseErrorCode["CloseBraceExpected"] = 7] = "CloseBraceExpected";
  ParseErrorCode[ParseErrorCode["CloseBracketExpected"] = 8] = "CloseBracketExpected";
  ParseErrorCode[ParseErrorCode["EndOfFileExpected"] = 9] = "EndOfFileExpected";
  ParseErrorCode[ParseErrorCode["InvalidCommentToken"] = 10] = "InvalidCommentToken";
  ParseErrorCode[ParseErrorCode["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
  ParseErrorCode[ParseErrorCode["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
  ParseErrorCode[ParseErrorCode["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
  ParseErrorCode[ParseErrorCode["InvalidUnicode"] = 14] = "InvalidUnicode";
  ParseErrorCode[ParseErrorCode["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
  ParseErrorCode[ParseErrorCode["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));
function modify(text, path, value, options) {
  return setProperty(text, path, value, options);
}
function applyEdits(text, edits) {
  let sortedEdits = edits.slice(0).sort((a, b) => {
    const diff = a.offset - b.offset;
    if (diff === 0) {
      return a.length - b.length;
    }
    return diff;
  });
  let lastModifiedOffset = text.length;
  for (let i = sortedEdits.length - 1;i >= 0; i--) {
    let e = sortedEdits[i];
    if (e.offset + e.length <= lastModifiedOffset) {
      text = applyEdit(text, e);
    } else {
      throw new Error("Overlapping edit");
    }
    lastModifiedOffset = e.offset;
  }
  return text;
}

var home = () => os.homedir();
function cliConfigPath() {
  const base = process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "opencode");
  return path.join(base, "cli.json");
}
function parseObject(text, source) {
  const errors = [];
  const value = parse2(text, errors, { allowTrailingComma: true });
  if (errors.length || typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${source} is not a valid JSON object`);
  return value;
}
function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 384 });
    renameWithRetry(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
function renameWithRetry(from, to) {
  for (let attempt = 0;; attempt++) {
    try {
      return renameSync(from, to);
    } catch (error) {
      const code = error.code;
      if (attempt >= 5 || code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        throw error;
      Bun.sleepSync(20 * (attempt + 1));
    }
  }
}
function writeValue(file, keyPath, value) {
  const text = readText(file) ?? `{}
`;
  parseObject(text, file);
  const edited = applyEdits(text, modify(text, keyPath, value, { formattingOptions: { tabSize: 2, insertSpaces: true } }));
  writeAtomic(file, edited.endsWith(`
`) ? edited : edited + `
`);
}
function readObject(file) {
  const text = readText(file);
  return text === undefined ? {} : parseObject(text, file);
}
function tabsOverridden() {
  const content = process.env.OPENCODE_CLI_CONFIG_CONTENT;
  if (!content)
    return false;
  try {
    return parseObject(content, "OPENCODE_CLI_CONFIG_CONTENT").tabs !== undefined;
  } catch {
    return false;
  }
}
function readTabsMode() {
  const tabs = readObject(cliConfigPath()).tabs ?? {};
  if (tabs.mode === "auto" || tabs.mode === "on" || tabs.mode === "off")
    return tabs.mode;
  if (tabs.enabled === false)
    return "off";
  if (tabs.enabled === true)
    return "on";
  return "auto";
}
function writeTabsMode(mode) {
  const file = cliConfigPath();
  writeValue(file, ["tabs", "mode"], mode);
  if (readObject(file).tabs?.enabled !== undefined)
    writeValue(file, ["tabs", "enabled"], undefined);
}

var DEFAULT_KEYS = "123456789cghijklmnopqrstuvwxyz";
var DEFAULT_MODIFIER = "alt";
var DEFAULT_CONFIRM_CLOSE = false;
var MODIFIERS = new Set(["alt", "ctrl", "shift", "meta", "super", "hyper"]);
function readOptions(raw) {
  const warnings = [];
  let modifier = DEFAULT_MODIFIER;
  if (raw?.modifier !== undefined) {
    const value = typeof raw.modifier === "string" ? raw.modifier.trim().toLowerCase() : "";
    if (value && value.split("+").every((part) => MODIFIERS.has(part)))
      modifier = value;
    else
      warnings.push(`Ignoring modifier ${JSON.stringify(raw.modifier)}; using ${DEFAULT_MODIFIER}`);
  }
  let keys = DEFAULT_KEYS;
  if (raw?.keys !== undefined) {
    if (typeof raw.keys === "string" && /[a-z0-9]/i.test(raw.keys))
      keys = raw.keys;
    else
      warnings.push(`Ignoring keys ${JSON.stringify(raw.keys)}; it needs at least one of a-z or 0-9`);
  }
  const slotKeys = [...new Set(keys.toLowerCase())].filter((key) => /^[a-z0-9]$/.test(key));
  let confirmClose = DEFAULT_CONFIRM_CLOSE;
  if (raw?.confirmClose !== undefined) {
    if (typeof raw.confirmClose === "boolean")
      confirmClose = raw.confirmClose;
    else
      warnings.push(`Ignoring confirmClose ${JSON.stringify(raw.confirmClose)}; it needs true or false`);
  }
  return { modifier, slotKeys, confirmClose, warnings };
}

var NARROW_BREAKPOINT = 12;
var CHORD_TIMEOUT = 3000;
var TITLE_DIM = 0.2;
var MIN_GROUP_NAME = 6;
var GLOBAL_PROJECT = "global";
var GIT_RECHECK_TICKS = 50;
var SYNC_RETRY = 5000;
var UNKNOWN_GROUP = "\x00unknown";
var SPINNER = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
function truncate(value, width) {
  if (width <= 0)
    return "";
  if (value.length <= width)
    return value;
  if (width === 1)
    return "\u2026";
  return value.slice(0, width - 1) + "\u2026";
}
function mix(from, to, amount) {
  const blend = (a, b) => a + (b - a) * amount;
  return RGBA.fromValues(blend(from.r, to.r), blend(from.g, to.g), blend(from.b, to.b), blend(from.a, to.a));
}
function findGitRoot(directory) {
  for (let current = path2.resolve(directory);; ) {
    if (existsSync2(path2.join(current, ".git")))
      return true;
    const parent = path2.dirname(current);
    if (parent === current)
      return false;
    current = parent;
  }
}
function moveItem(items, from, to) {
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(Math.max(0, Math.min(to, result.length)), 0, item);
  return result;
}
function BetterTabs() {
  const ctx = usePlugin();
  const theme = () => ctx.theme;
  const [state, update] = ctx.storage.store("state", {
    initial: {
      collapsed: {},
      autoGroup: true,
      restoreMode: "auto",
      groupOrder: []
    }
  });
  const [memory, setMemory] = ctx.storage.memory("memory", {
    initial: {
      ids: []
    }
  });
  const toast = (message, variant = "info") => ctx.ui.toast.show({
    title: "Better tabs",
    message,
    variant
  });
  const fail = (error) => toast(error instanceof Error ? error.message : String(error), "error");
  const tabs = createMemo(() => {
    if (ctx.ui.tabs.enabled())
      return ctx.ui.tabs.list();
    return memory.ids.map((sessionID) => ({
      sessionID,
      active: false,
      busy: false,
      attention: false
    }));
  });
  createEffect(() => {
    if (!ctx.ui.tabs.enabled())
      return;
    const ids = ctx.ui.tabs.list().map((tab) => tab.sessionID);
    if (ids.length)
      setMemory((draft) => void (draft.ids = ids));
  });
  const requested = new Set;
  const [syncRetry, setSyncRetry] = createSignal(0);
  const retryTimers = new Set;
  onCleanup(() => retryTimers.forEach(clearTimeout));
  createEffect(() => {
    syncRetry();
    for (const tab of tabs()) {
      const sessionID = tab.sessionID;
      if (ctx.data.session.get(sessionID) || requested.has(sessionID))
        continue;
      requested.add(sessionID);
      ctx.data.session.sync(sessionID).catch(() => {
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          requested.delete(sessionID);
          setSyncRetry((value) => value + 1);
        }, SYNC_RETRY);
        retryTimers.add(timer);
      });
    }
  });
  const gitCache = new Map;
  const [gitVersion, setGitVersion] = createSignal(0);
  const insideGit = (directory) => {
    gitVersion();
    let found = gitCache.get(directory);
    if (found === undefined)
      gitCache.set(directory, found = findGitRoot(directory));
    return found;
  };
  const recheckGit = () => {
    let changed = false;
    for (const [directory, found] of gitCache) {
      const now = findGitRoot(directory);
      if (now === found)
        continue;
      gitCache.set(directory, now);
      changed = true;
    }
    if (changed)
      setGitVersion((value) => value + 1);
  };
  const groupOf = (sessionID) => {
    const session = ctx.data.session.get(sessionID);
    if (!session)
      return;
    const directory = session.location.directory;
    if (session.projectID === GLOBAL_PROJECT) {
      const normalized = path2.resolve(directory);
      const key = process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
      return {
        key: `dir:${key}`,
        name: path2.basename(normalized) || normalized,
        noGit: !insideGit(normalized)
      };
    }
    const project = ctx.data.project.get(session.projectID);
    const canonical = project?.canonical ?? directory;
    const name = project?.name || path2.basename(canonical) || canonical;
    return {
      key: session.projectID,
      name,
      noGit: !!project && !project.vcs && !insideGit(canonical)
    };
  };
  const titleOf = (tab) => ctx.data.session.get(tab.sessionID)?.title ?? tab.title ?? "Untitled session";
  const [localOrder, setLocalOrder] = createSignal();
  let orderWrites = 0;
  const orderedGroups = createMemo(() => {
    const result = new Map;
    for (const tab of tabs()) {
      const info = groupOf(tab.sessionID) ?? {
        key: UNKNOWN_GROUP,
        name: "\u2026",
        noGit: false
      };
      const group = result.get(info.key) ?? {
        ...info,
        tabs: []
      };
      group.tabs.push(tab);
      result.set(info.key, group);
    }
    const order = localOrder() ?? state.groupOrder ?? [];
    const rank = (key) => {
      const index = order.indexOf(key);
      return index === -1 ? order.length : index;
    };
    return [...result.values()].sort((left, right) => rank(left.key) - rank(right.key));
  });
  const [drag, setDrag] = createSignal();
  const groups = createMemo(() => {
    const list = orderedGroups();
    const current = drag();
    if (!current?.moved)
      return list;
    const from = list.findIndex((group) => group.key === current.key);
    return from === -1 ? list : moveItem(list, from, current.target);
  });
  const moveGroup = (key, to) => {
    const list = orderedGroups().map((group) => group.key);
    const from = list.indexOf(key);
    if (from === -1)
      return;
    const next = moveItem(list, from, to);
    const merge = (saved = []) => [...next, ...saved.filter((item) => !next.includes(item))];
    setLocalOrder(merge(localOrder() ?? state.groupOrder));
    const write = ++orderWrites;
    update((draft) => void (draft.groupOrder = merge(draft.groupOrder))).catch(fail).finally(() => {
      if (write === orderWrites)
        setLocalOrder(undefined);
    });
  };
  const applyGrouping = () => {
    if (!ctx.ui.tabs.enabled())
      return;
    const list = orderedGroups();
    if (list.some((group) => group.key === UNKNOWN_GROUP))
      return;
    const target = list.flatMap((group) => group.tabs.map((tab) => tab.sessionID));
    const current = ctx.ui.tabs.list().map((tab) => tab.sessionID);
    target.forEach((id, index) => {
      if (current[index] === id)
        return;
      ctx.ui.tabs.move(id, index);
      current.splice(current.indexOf(id), 1);
      current.splice(index, 0, id);
    });
  };
  createEffect(() => {
    if (!state.autoGroup)
      return;
    orderedGroups();
    untrack(applyGrouping);
  });
  const focus = (sessionID) => {
    if (!ctx.ui.tabs.focus(sessionID))
      ctx.ui.router.navigate({
        type: "session",
        sessionID
      });
  };
  const options = readOptions(ctx.options);
  for (const warning of options.warnings)
    toast(warning, "warning");
  const {
    modifier,
    slotKeys,
    confirmClose
  } = options;
  const [pending, setPending] = createSignal();
  let chordTimer;
  const clearChord = () => {
    clearTimeout(chordTimer);
    chordTimer = undefined;
    setPending(undefined);
  };
  onCleanup(clearChord);
  const armChord = (key) => {
    setPending(key);
    clearTimeout(chordTimer);
    chordTimer = setTimeout(clearChord, CHORD_TIMEOUT);
  };
  const chord = (slot) => {
    const selected = pending();
    if (selected === undefined) {
      const group = groups()[slot];
      if (!group)
        return false;
      armChord(group.key);
      return;
    }
    const tab = groups().find((group) => group.key === selected)?.tabs[slot];
    clearChord();
    if (tab)
      focus(tab.sessionID);
  };
  const moveSelected = (delta) => {
    const selected = pending();
    if (selected === undefined)
      return;
    const from = orderedGroups().findIndex((group) => group.key === selected);
    if (from === -1)
      return;
    moveGroup(selected, Math.max(0, Math.min(orderedGroups().length - 1, from + delta)));
    armChord(selected);
  };
  const slotLabel = (slot) => {
    const key = slotKeys[slot];
    if (!key)
      return "";
    const list = ctx.keymap.shortcuts(`better-tabs.key.${key}`);
    return list.find((value) => !value.includes(" ")) ?? list[0] ?? `${modifier}+${key}`;
  };
  let anchor;
  const [host, setHost] = createSignal();
  const [geometry, setGeometry] = createSignal({
    width: 0,
    height: 0
  });
  const measure = () => {
    if (!anchor || anchor.isDestroyed)
      return;
    const row = anchor.parent?.parent ?? undefined;
    if (row !== host())
      setHost(row);
    const width = row ? anchor.screenX - row.screenX : 0;
    const height = row ? row.height : 0;
    const previous = geometry();
    if (previous.width !== width || previous.height !== height)
      setGeometry({
        width,
        height
      });
  };
  const [tick, setTick] = createSignal(0);
  const anyBusy = createMemo(() => tabs().some((tab) => tab.busy));
  let ticks = 0;
  const timer = setInterval(() => {
    measure();
    if (anyBusy())
      setTick((value) => (value + 1) % SPINNER.length);
    if (++ticks % GIT_RECHECK_TICKS === 0)
      recheckGit();
  }, 100);
  onCleanup(() => clearInterval(timer));
  const visible = () => ctx.ui.tabs.enabled() && geometry().width >= 5 && tabs().length > 0;
  const innerWidth = () => Math.max(1, geometry().width - 1);
  const narrow = () => geometry().width < NARROW_BREAKPOINT;
  const groupKeys = createMemo(() => groups().map((group) => group.key), [], {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index])
  });
  const groupByKey = (key) => groups().find((group) => group.key === key);
  const visibleTabIDs = (group) => group.tabs.filter((tab) => !state.collapsed[group.key] || tab.active || pending() === group.key).map((tab) => tab.sessionID);
  const status = (tab) => {
    const t = theme();
    if (tab.attention)
      return {
        char: "!",
        color: t.text.feedback.warning.base
      };
    if (tab.busy)
      return {
        char: SPINNER[tick()],
        color: t.hue.interactive[200]
      };
    if (tab.unread === "error")
      return {
        char: "\u2022",
        color: t.text.feedback.error.base
      };
    if (tab.unread === "activity")
      return {
        char: "\u2022",
        color: t.hue.accent[200]
      };
    return {
      char: " ",
      color: t.text.muted
    };
  };
  const groupStatus = (group) => {
    const found = group.tabs.find((tab) => tab.attention) ?? group.tabs.find((tab) => tab.busy) ?? group.tabs.find((tab) => tab.unread);
    return found ? status(found) : undefined;
  };
  const groupCounts = (group, width) => {
    const t = theme();
    const count = (match) => group.tabs.filter(match).length;
    const busy = count((tab) => tab.busy);
    const waiting = count((tab) => !!tab.attention);
    const unread = count((tab) => !!tab.unread);
    const error = group.tabs.some((tab) => tab.unread === "error");
    const items = [{
      drop: 1,
      n: busy,
      text: `${SPINNER[tick()]}${busy}`,
      color: t.hue.interactive[200]
    }, {
      drop: 2,
      n: waiting,
      text: `!${waiting}`,
      color: t.text.feedback.warning.base
    }, {
      drop: 0,
      n: unread,
      text: `\u2022${unread}`,
      color: error ? t.text.feedback.error.base : t.hue.accent[200]
    }].filter((item) => item.n > 0);
    const fits = (list) => list.reduce((sum, item) => sum + item.text.length + 1, 0) <= width;
    let shown = items;
    for (const level of [0, 1, 2]) {
      if (fits(shown))
        break;
      shown = shown.filter((item) => item.drop !== level);
    }
    return fits(shown) ? shown : [];
  };
  const toggleGroup = (key) => void update((draft) => {
    if (draft.collapsed[key])
      delete draft.collapsed[key];
    else
      draft.collapsed[key] = true;
  }).catch(fail);
  const [hovered, setHovered] = createSignal();
  let dropped = false;
  const click = (event, run) => {
    event.stopPropagation();
    if (!dropped)
      run();
  };
  const background = () => theme().background.raised.base;
  const titleColor = createMemo(() => mix(theme().text.base, theme().text.muted, TITLE_DIM));
  const rowBackground = (id, active) => active ? theme().background.raised.max : hovered() === id ? theme().background.raised.high : background();
  const headers = new Map;
  const dropTarget = (key, y) => orderedGroups().filter((group) => {
    if (group.key === key)
      return false;
    const header = headers.get(group.key);
    return !!header && !header.isDestroyed && header.screenY < y;
  }).length;
  const dragMove = (event) => {
    const current = drag();
    if (!current)
      return;
    const moved = current.moved || event.y !== current.startY;
    if (moved)
      setDrag({
        ...current,
        moved,
        target: dropTarget(current.key, event.y)
      });
  };
  const finishDrag = () => {
    const current = drag();
    if (!current)
      return false;
    setDrag(undefined);
    if (!current.moved)
      return false;
    moveGroup(current.key, current.target);
    dropped = true;
    setTimeout(() => dropped = false);
    return true;
  };
  function GroupRow(props) {
    const id = () => `group:${props.group.key}`;
    const selected = () => pending() === props.group.key;
    const dragging = () => drag()?.key === props.group.key && drag()?.moved;
    const arrow = () => props.collapsed && !selected() ? "\u25B8" : "\u25BE";
    const keys = () => dragging() ? "\u21C5" : pending() === undefined ? slotLabel(props.position) : "";
    const keysWidth = () => keys() ? keys().length + 2 : 0;
    const counts = createMemo(() => groupCounts(props.group, innerWidth() - 3 - MIN_GROUP_NAME - keysWidth()));
    const countsWidth = () => counts().reduce((width, item) => width + item.text.length + 1, 0);
    const nameWidth = () => innerWidth() - 3 - countsWidth() - keysWidth();
    const marker = () => groupStatus(props.group);
    const noGitLabel = () => props.group.noGit && nameWidth() - props.group.name.length >= 7 ? " no git" : "";
    let header;
    onCleanup(() => {
      if (headers.get(props.group.key) === header)
        headers.delete(props.group.key);
    });
    return (() => {
      var _el$ = _$createElement("box");
      _$use((element) => headers.set(props.group.key, header = element), _el$);
      _$setProp(_el$, "flexDirection", "row");
      _$setProp(_el$, "height", 1);
      _$setProp(_el$, "flexShrink", 0);
      _$setProp(_el$, "onMouseOver", () => setHovered(id()));
      _$setProp(_el$, "onMouseOut", () => setHovered(undefined));
      _$setProp(_el$, "onMouseDown", (event) => {
        if (event.button !== 0)
          return;
        event.stopPropagation();
        setDrag({
          key: props.group.key,
          startY: event.y,
          moved: false,
          target: props.position
        });
      });
      _$setProp(_el$, "onMouseUp", (event) => click(event, () => {
        if (!finishDrag() && event.button === 0)
          toggleGroup(props.group.key);
      }));
      _$insert(_el$, _$createComponent(Show, {
        get when() {
          return !narrow();
        },
        get fallback() {
          return [(() => {
            var _el$7 = _$createElement("text");
            _$setProp(_el$7, "selectable", false);
            _$insert(_el$7, () => truncate(arrow() + props.group.name, innerWidth() - (marker() ? 1 : 0)));
            _$effect((_$p) => _$setProp(_el$7, "fg", theme().hue.accent[200], _$p));
            return _el$7;
          })(), (() => {
            var _el$8 = _$createElement("box");
            _$setProp(_el$8, "flexGrow", 1);
            return _el$8;
          })(), (() => {
            var _el$9 = _$createElement("text");
            _$setProp(_el$9, "selectable", false);
            _$insert(_el$9, () => marker()?.char ?? "");
            _$effect((_$p) => _$setProp(_el$9, "fg", marker()?.color, _$p));
            return _el$9;
          })()];
        },
        get children() {
          return [(() => {
            var _el$2 = _$createElement("text");
            _$setProp(_el$2, "selectable", false);
            _$insert(_el$2, () => ` ${arrow()} `);
            _$effect((_$p) => _$setProp(_el$2, "fg", theme().text.muted, _$p));
            return _el$2;
          })(), (() => {
            var _el$3 = _$createElement("text");
            _$setProp(_el$3, "selectable", false);
            _$insert(_el$3, () => truncate(props.group.name, nameWidth()));
            _$effect((_$p) => _$setProp(_el$3, "fg", dragging() ? theme().text.base : theme().hue.accent[200], _$p));
            return _el$3;
          })(), (() => {
            var _el$4 = _$createElement("text");
            _$setProp(_el$4, "selectable", false);
            _$insert(_el$4, noGitLabel);
            _$effect((_$p) => _$setProp(_el$4, "fg", theme().text.muted, _$p));
            return _el$4;
          })(), (() => {
            var _el$5 = _$createElement("box");
            _$setProp(_el$5, "flexGrow", 1);
            return _el$5;
          })(), _$createComponent(For, {
            get each() {
              return counts();
            },
            children: (item) => (() => {
              var _el$0 = _$createElement("text");
              _$setProp(_el$0, "selectable", false);
              _$insert(_el$0, () => item.text + " ");
              _$effect((_$p) => _$setProp(_el$0, "fg", item.color, _$p));
              return _el$0;
            })()
          }), _$createComponent(Show, {
            get when() {
              return keys();
            },
            get children() {
              var _el$6 = _$createElement("text");
              _$setProp(_el$6, "selectable", false);
              _$insert(_el$6, () => keys() + " ");
              _$effect((_$p) => _$setProp(_el$6, "fg", dragging() ? theme().text.base : selected() ? theme().hue.accent[200] : theme().text.muted, _$p));
              return _el$6;
            }
          })];
        }
      }));
      _$effect((_$p) => _$setProp(_el$, "backgroundColor", dragging() ? theme().background.action.primary.selected : selected() ? theme().background.raised.high : rowBackground(id(), false), _$p));
      return _el$;
    })();
  }
  function TabRow(props) {
    const id = () => `tab:${props.tab.sessionID}`;
    const armed = () => pending() === props.groupKey;
    const dragged = () => !!drag()?.moved && props.groupKey === drag()?.key;
    const keys = () => armed() ? slotLabel(props.position) : "";
    const showKeys = () => keys().length > 0 && innerWidth() - 5 - keys().length - 2 >= 6;
    const titleWidth = () => innerWidth() - 5 - (showKeys() ? keys().length + 2 : 0);
    const [closeHovered, setCloseHovered] = createSignal(false);
    return (() => {
      var _el$1 = _$createElement("box"), _el$10 = _$createElement("text"), _el$11 = _$createElement("text");
      _$insertNode(_el$1, _el$10);
      _$insertNode(_el$1, _el$11);
      _$setProp(_el$1, "flexDirection", "row");
      _$setProp(_el$1, "height", 1);
      _$setProp(_el$1, "flexShrink", 0);
      _$setProp(_el$1, "onMouseOver", () => setHovered(id()));
      _$setProp(_el$1, "onMouseOut", () => setHovered(undefined));
      _$setProp(_el$1, "onMouseUp", (event) => click(event, () => {
        if (event.button === 1)
          requestClose(props.tab.sessionID).catch(fail);
        else if (event.button === 0)
          focus(props.tab.sessionID);
      }));
      _$setProp(_el$10, "selectable", false);
      _$insert(_el$10, () => props.tab.active ? "\u258C" : " ");
      _$setProp(_el$11, "selectable", false);
      _$insert(_el$11, () => status(props.tab).char);
      _$insert(_el$1, _$createComponent(Show, {
        get when() {
          return !narrow();
        },
        get fallback() {
          return (() => {
            var _el$19 = _$createElement("text");
            _$setProp(_el$19, "selectable", false);
            _$insert(_el$19, (() => {
              var _c$ = _$memo(() => !!armed());
              return () => _c$() ? slotKeys[props.position] ?? "" : "";
            })());
            _$effect((_$p) => _$setProp(_el$19, "fg", theme().hue.accent[200], _$p));
            return _el$19;
          })();
        },
        get children() {
          return [(() => {
            var _el$12 = _$createElement("text");
            _$insertNode(_el$12, _$createTextNode(` `));
            _$setProp(_el$12, "selectable", false);
            return _el$12;
          })(), (() => {
            var _el$14 = _$createElement("text");
            _$setProp(_el$14, "selectable", false);
            _$insert(_el$14, () => truncate(titleOf(props.tab), titleWidth()));
            _$effect((_$p) => _$setProp(_el$14, "fg", titleColor(), _$p));
            return _el$14;
          })(), (() => {
            var _el$15 = _$createElement("box");
            _$setProp(_el$15, "flexGrow", 1);
            return _el$15;
          })(), _$createComponent(Show, {
            get when() {
              return showKeys();
            },
            get children() {
              var _el$16 = _$createElement("text");
              _$setProp(_el$16, "selectable", false);
              _$insert(_el$16, () => keys() + " ");
              _$effect((_$p) => _$setProp(_el$16, "fg", armed() ? theme().hue.accent[200] : theme().text.muted, _$p));
              return _el$16;
            }
          }), (() => {
            var _el$17 = _$createElement("box"), _el$18 = _$createElement("text");
            _$insertNode(_el$17, _el$18);
            _$setProp(_el$17, "width", 2);
            _$setProp(_el$17, "flexShrink", 0);
            _$setProp(_el$17, "onMouseOver", () => setCloseHovered(true));
            _$setProp(_el$17, "onMouseOut", () => setCloseHovered(false));
            _$setProp(_el$17, "onMouseUp", (event) => click(event, () => {
              if (event.button === 0 && hovered() === id())
                requestClose(props.tab.sessionID).catch(fail);
            }));
            _$setProp(_el$18, "selectable", false);
            _$insert(_el$18, () => hovered() === id() ? "\u2715 " : "  ");
            _$effect((_$p) => _$setProp(_el$18, "fg", closeHovered() ? theme().text.feedback.error.base : theme().text.muted, _$p));
            return _el$17;
          })()];
        }
      }), null);
      _$effect((_p$) => {
        var _v$ = dragged() ? theme().background.raised.high : rowBackground(id(), props.tab.active), _v$2 = theme().hue.accent[300], _v$3 = status(props.tab).color;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$1, "backgroundColor", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$10, "fg", _v$2, _p$.t));
        _v$3 !== _p$.a && (_p$.a = _$setProp(_el$11, "fg", _v$3, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$1;
    })();
  }
  function sticky(read) {
    let last;
    return createMemo(() => last = read() ?? last);
  }
  function GroupBlock(props) {
    const group = sticky(() => groupByKey(props.groupKey));
    return _$createComponent(Show, {
      get when() {
        return group();
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return props.position > 0;
          },
          get children() {
            var _el$20 = _$createElement("box");
            _$setProp(_el$20, "height", 1);
            _$setProp(_el$20, "flexShrink", 0);
            return _el$20;
          }
        }), _$createComponent(GroupRow, {
          get group() {
            return group();
          },
          get position() {
            return props.position;
          },
          get collapsed() {
            return !!state.collapsed[props.groupKey];
          }
        }), _$createComponent(For, {
          get each() {
            return visibleTabIDs(group());
          },
          children: (sessionID) => _$createComponent(TabItem, {
            get group() {
              return group();
            },
            sessionID
          })
        })];
      }
    });
  }
  function TabItem(props) {
    const tab = sticky(() => props.group.tabs.find((item) => item.sessionID === props.sessionID));
    const position = () => props.group.tabs.findIndex((item) => item.sessionID === props.sessionID);
    return _$createComponent(Show, {
      get when() {
        return tab();
      },
      get children() {
        return _$createComponent(TabRow, {
          get tab() {
            return tab();
          },
          get groupKey() {
            return props.group.key;
          },
          get position() {
            return Math.max(0, position());
          }
        });
      }
    });
  }
  function NewSessionRow() {
    return (() => {
      var _el$21 = _$createElement("box"), _el$22 = _$createElement("text");
      _$insertNode(_el$21, _el$22);
      _$setProp(_el$21, "flexDirection", "row");
      _$setProp(_el$21, "height", 1);
      _$setProp(_el$21, "flexShrink", 0);
      _$setProp(_el$21, "onMouseOver", () => setHovered("new"));
      _$setProp(_el$21, "onMouseOut", () => setHovered(undefined));
      _$setProp(_el$21, "onMouseUp", (event) => click(event, () => ctx.keymap.dispatch("session.new")));
      _$setProp(_el$22, "selectable", false);
      _$insert(_el$22, () => narrow() ? " +" : " + New session");
      _$effect((_p$) => {
        var _v$4 = rowBackground("new", false), _v$5 = theme().text.muted;
        _v$4 !== _p$.e && (_p$.e = _$setProp(_el$21, "backgroundColor", _v$4, _p$.e));
        _v$5 !== _p$.t && (_p$.t = _$setProp(_el$22, "fg", _v$5, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$21;
    })();
  }
  const toggleHidden = () => {
    try {
      if (tabsOverridden())
        toast("OPENCODE_CLI_CONFIG_CONTENT overrides tabs, so cli.json changes have no effect", "warning");
      const mode = readTabsMode();
      if (mode === "off") {
        writeTabsMode(state.restoreMode === "off" ? "auto" : state.restoreMode);
        return;
      }
      update((draft) => void (draft.restoreMode = mode)).catch(fail);
      writeTabsMode("off");
    } catch (error) {
      fail(error);
    }
  };
  const closeCurrent = () => {
    if (!ctx.ui.tabs.close())
      toast("No tab is open", "warning");
  };
  const requestClose = async (sessionID) => {
    if (confirmClose) {
      const tab = tabs().find((item) => item.sessionID === sessionID);
      const answer = await ctx.ui.dialog.confirm({
        title: "Close tab",
        message: tab ? `Close \u201C${titleOf(tab)}\u201D? The session is kept and can be reopened.` : "Close this tab?",
        label: {
          confirm: "Close",
          cancel: "Cancel"
        }
      });
      if (!answer)
        return;
    }
    ctx.ui.tabs.close(sessionID);
  };
  const setAllCollapsed = (collapsed) => void update((draft) => {
    draft.collapsed = {};
    if (collapsed)
      for (const group of groups())
        draft.collapsed[group.key] = true;
  }).catch(fail);
  const openPicker = async () => {
    const options = groups().flatMap((group, position) => group.tabs.map((tab, index) => ({
      title: titleOf(tab),
      value: tab.sessionID,
      category: group.name,
      footer: position < slotKeys.length && index < slotKeys.length ? `${slotLabel(position)} ${slotLabel(index)}` : undefined
    })));
    const selected = await ctx.ui.dialog.select({
      title: "Tabs",
      placeholder: "Search tabs",
      options,
      current: tabs().find((tab) => tab.active)?.sessionID
    });
    if (selected)
      focus(selected);
  };
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "better-tabs.picker",
      title: "Find tab",
      group: "Better tabs",
      bind: "<leader>p",
      palette: true,
      slash: {
        name: "tabs"
      },
      run: () => void openPicker().catch(fail)
    }, {
      id: "better-tabs.hide",
      title: "Show or hide tabs",
      group: "Better tabs",
      bind: "<leader>h",
      palette: true,
      slash: {
        name: "tabs-hide"
      },
      run: toggleHidden
    }, {
      id: "better-tabs.close",
      title: "Close current tab",
      group: "Better tabs",
      palette: true,
      slash: {
        name: "close"
      },
      run: closeCurrent
    }, {
      id: "better-tabs.archive",
      title: "Archive current tab",
      group: "Better tabs",
      palette: true,
      slash: {
        name: "archive"
      },
      run: closeCurrent
    }, {
      id: "better-tabs.group",
      title: "Group tabs by repository",
      group: "Better tabs",
      palette: true,
      run: applyGrouping
    }, {
      id: "better-tabs.autogroup",
      title: "Toggle automatic tab grouping",
      group: "Better tabs",
      palette: true,
      run: () => void update((draft) => void (draft.autoGroup = !draft.autoGroup)).then(() => toast(`Automatic grouping ${state.autoGroup ? "on" : "off"}`)).catch(fail)
    }, {
      id: "better-tabs.collapse-all",
      title: "Collapse all tab groups",
      group: "Better tabs",
      palette: true,
      run: () => setAllCollapsed(true)
    }, {
      id: "better-tabs.expand-all",
      title: "Expand all tab groups",
      group: "Better tabs",
      palette: true,
      run: () => setAllCollapsed(false)
    }]
  }));
  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 200,
    enabled: () => pending() !== undefined,
    commands: [{
      title: "Cancel tab group selection",
      group: "Better tabs",
      bind: `escape,${modifier}+x,${modifier}+escape`,
      run: clearChord
    }, {
      title: "Move tab group up",
      group: "Better tabs",
      bind: `${modifier}+up`,
      run: () => moveSelected(-1)
    }, {
      title: "Move tab group down",
      group: "Better tabs",
      bind: `${modifier}+down`,
      run: () => moveSelected(1)
    }]
  }));
  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: slotKeys.map((key, slot) => ({
      id: `better-tabs.key.${key}`,
      title: `Select tab group ${slot + 1}, then a tab in it`,
      group: "Better tabs",
      bind: `${modifier}+${key}`,
      run: () => chord(slot)
    }))
  }));
  return [(() => {
    var _el$23 = _$createElement("box");
    _$use((element) => anchor = element, _el$23);
    _$setProp(_el$23, "height", 0);
    _$setProp(_el$23, "flexShrink", 0);
    return _el$23;
  })(), _$createComponent(Show, {
    get when() {
      return _$memo(() => !!visible())() && host();
    },
    keyed: true,
    children: (row) => _$createComponent(Portal, {
      mount: row,
      ref: (element) => {
        const container = element;
        container.position = "absolute";
        container.left = 0;
        container.top = 0;
        container.zIndex = 20;
      },
      get children() {
        var _el$24 = _$createElement("box"), _el$25 = _$createElement("scrollbox"), _el$26 = _$createElement("box"), _el$27 = _$createElement("box");
        _$insertNode(_el$24, _el$25);
        _$setProp(_el$24, "flexDirection", "column");
        _$setProp(_el$24, "onMouseDrag", dragMove);
        _$setProp(_el$24, "onMouseDragEnd", () => finishDrag());
        _$setProp(_el$24, "onMouseUp", () => finishDrag());
        _$insertNode(_el$25, _el$26);
        _$setProp(_el$25, "flexGrow", 1);
        _$setProp(_el$25, "minHeight", 0);
        _$setProp(_el$25, "scrollbarOptions", {
          visible: false
        });
        _$insertNode(_el$26, _el$27);
        _$setProp(_el$26, "flexDirection", "column");
        _$setProp(_el$26, "flexShrink", 0);
        _$setProp(_el$26, "paddingTop", 1);
        _$insert(_el$26, _$createComponent(For, {
          get each() {
            return groupKeys();
          },
          children: (key, position) => _$createComponent(GroupBlock, {
            groupKey: key,
            get position() {
              return position();
            }
          })
        }), _el$27);
        _$setProp(_el$27, "height", 1);
        _$setProp(_el$27, "flexShrink", 0);
        _$insert(_el$26, _$createComponent(NewSessionRow, {}), null);
        _$effect((_p$) => {
          var _v$6 = innerWidth(), _v$7 = geometry().height, _v$8 = background();
          _v$6 !== _p$.e && (_p$.e = _$setProp(_el$24, "width", _v$6, _p$.e));
          _v$7 !== _p$.t && (_p$.t = _$setProp(_el$24, "height", _v$7, _p$.t));
          _v$8 !== _p$.a && (_p$.a = _$setProp(_el$24, "backgroundColor", _v$8, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$24;
      }
    })
  })];
}
var tui_default = Plugin.define({
  id: "better-tabs",
  setup(context) {
    context.data.project.sync().catch(() => {});
    return context.ui.slot({
      append: "app",
      render: () => _$createComponent(BetterTabs, {})
    });
  }
});
export {
  tui_default as default
};
