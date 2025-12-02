// Thx: https://github.com/Vinzent03/obsidian-git/blob/master/polyfill_buffer.js
// Thx: https://github.com/isomorphic-git/isomorphic-git/issues/1680

import { Platform } from 'obsidian';
let buffer;
if (Platform.isMobileApp) {
    buffer = require('buffer/index.js').Buffer
    globalThis.Buffer = buffer;
} else {
    buffer = global.Buffer
}

export const Buffer = buffer;