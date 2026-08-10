/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Based on @sergeche's work on the emmet plugin for atom

import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { imageSize } from 'image-size';
import { ISizeCalculationResult } from 'image-size/dist/types/interface';

const reUrl = /^https?:/;

// CLAWDIUS-BEGIN refuse ICNS before image-size parses it
// image-size's ICNS reader walks the icon table using each entry's own declared length, and an entry that
// declares zero (or a length that does not advance past its header) leaves the cursor where it was, so the
// walk never terminates. There is no fixed release: the advisory range is every published version. The
// parser is chosen by magic bytes, not by file extension, so a file called `logo.png` still reaches it.
//
// This helper only exists to fill width/height on markup, and no browser renders ICNS, so refusing it costs
// nothing real. The check is the same four-byte comparison the reader itself uses to claim the buffer, so
// it rejects exactly the inputs that would have reached the loop and nothing else. Only ICNS is refused:
// the advisory covering the JXL and HEIF readers describes code added in a later major version, and the
// pinned one registers neither.
const ICNS_MAGIC = 'icns';

function isIcnsBuffer(buffer: Buffer): boolean {
	return buffer.length >= 4 && buffer.toString('ascii', 0, 4) === ICNS_MAGIC;
}

/** Read only the four magic bytes; a file that cannot be opened is left for `imageSize` to report. */
async function isIcnsFile(file: string): Promise<boolean> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(file, 'r');
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
		return bytesRead >= 4 && isIcnsBuffer(buffer);
	} catch {
		return false;
	} finally {
		await handle?.close();
	}
}

class UnsupportedImageFormatError extends Error {
	constructor() {
		super('Reading the size of an ICNS image is not supported.');
	}
}
// CLAWDIUS-END
export type ImageInfoWithScale = {
	realWidth: number;
	realHeight: number;
	width: number;
	height: number;
};

/**
 * Get size of given image file. Supports files from local filesystem,
 * as well as URLs
 */
export function getImageSize(file: string): Promise<ImageInfoWithScale | undefined> {
	file = file.replace(/^file:\/\//, '');
	return reUrl.test(file) ? getImageSizeFromURL(file) : getImageSizeFromFile(file);
}

/**
 * Get image size from file on local file system
 */
async function getImageSizeFromFile(file: string): Promise<ImageInfoWithScale | undefined> {
	const isDataUrl = file.match(/^data:.+?;base64,/);

	if (isDataUrl) {
		// NB should use sync version of `sizeOf()` for buffers
		const data = Buffer.from(file.slice(isDataUrl[0].length), 'base64');
		// CLAWDIUS: see the ICNS note above.
		if (isIcnsBuffer(data)) {
			throw new UnsupportedImageFormatError();
		}
		return sizeForFileName('', imageSize(data));
	}

	// CLAWDIUS: `imageSize` opens the file itself, so the magic bytes have to be read before calling it.
	if (await isIcnsFile(file)) {
		throw new UnsupportedImageFormatError();
	}

	return new Promise((resolve, reject) => {
		imageSize(file, (err: Error | null, size?: ISizeCalculationResult) => {
			if (err) {
				reject(err);
			} else {
				resolve(sizeForFileName(path.basename(file), size));
			}
		});
	});
}

/**
 * Get image size from given remove URL
 */
function getImageSizeFromURL(urlStr: string): Promise<ImageInfoWithScale | undefined> {
	return new Promise((resolve, reject) => {
		const url = new URL(urlStr);
		const getTransport = url.protocol === 'https:' ? https.get : http.get;

		if (!url.pathname) {
			return reject('Given url doesnt have pathname property');
		}
		const urlPath: string = url.pathname;

		getTransport(url, resp => {
			const chunks: Buffer[] = [];
			let bufSize = 0;

			const trySize = (chunks: Buffer[]) => {
				try {
					const size: ISizeCalculationResult = imageSize(Buffer.concat(chunks, bufSize));
					resp.removeListener('data', onData);
					resp.destroy(); // no need to read further
					resolve(sizeForFileName(path.basename(urlPath), size));
				} catch (err) {
					// might not have enough data, skip error
				}
			};

			const onData = (chunk: Buffer) => {
				bufSize += chunk.length;
				chunks.push(chunk);
				// CLAWDIUS-BEGIN refuse ICNS before image-size parses it
				// Checked here rather than inside `trySize`, which swallows every error so that a short read can
				// be retried on the next chunk - a rejection raised in there would be discarded and the response
				// would keep streaming. Four bytes are enough to decide, so this settles on the first chunk.
				if (bufSize >= 4 && isIcnsBuffer(Buffer.concat(chunks, bufSize))) {
					resp.removeListener('data', onData);
					resp.destroy();
					return reject(new UnsupportedImageFormatError());
				}
				// CLAWDIUS-END
				trySize(chunks);
			};

			resp
				.on('data', onData)
				.on('end', () => trySize(chunks))
				.once('error', err => {
					resp.removeListener('data', onData);
					reject(err);
				});
		}).once('error', reject);
	});
}

/**
 * Returns size object for given file name. If file name contains `@Nx` token,
 * the final dimentions will be downscaled by N
 */
function sizeForFileName(fileName: string, size?: ISizeCalculationResult): ImageInfoWithScale | undefined {
	const m = fileName.match(/@(\d+)x\./);
	const scale = m ? +m[1] : 1;

	if (!size || !size.width || !size.height) {
		return;
	}

	return {
		realWidth: size.width,
		realHeight: size.height,
		width: Math.floor(size.width / scale),
		height: Math.floor(size.height / scale)
	};
}
