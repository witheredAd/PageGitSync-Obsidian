// Thx: https://github.com/Vinzent03/obsidian-git/blob/master/src/gitManager/isomorphicGit.ts

import type {
    GitHttpRequest,
    GitHttpResponse,
} from 'isomorphic-git'

import { requestUrl } from 'obsidian';

async function* arrayBufferToAsyncIterator(
    buffer: ArrayBuffer
): AsyncIterableIterator<Uint8Array> {
    yield new Uint8Array(buffer);
}

async function asyncIteratorToArrayBuffer(
    iterator: AsyncIterableIterator<Uint8Array>
): Promise<ArrayBuffer> {
    const stream = new ReadableStream({
        async start(controller) {
            for await (const chunk of iterator) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });

    const response = new Response(stream);
    return await response.arrayBuffer();
}

export const ObsidianHTTPClient = {
    async request({
        url,
        method,
        headers,
        body,
    }: GitHttpRequest): Promise<GitHttpResponse> {
        // We can't stream yet, so collect body and set it to the ArrayBuffer
        // because that's what requestUrl expects
        let collectedBody: ArrayBuffer | undefined;
        if (body) {
            collectedBody = await asyncIteratorToArrayBuffer(body);
        }

        const res = await requestUrl({
            url,
            method,
            headers,
            body: collectedBody,
            throw: false,
        });

        return {
            url,
            method,
            headers: res.headers,
            body: arrayBufferToAsyncIterator(res.arrayBuffer),
            statusCode: res.status,
            statusMessage: res.status.toString(),
        };
    },
}