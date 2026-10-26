import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";

/**
 * Yields the lines of a byte stream without buffering beyond the current
 * chunk. Stream errors reject the iteration. Destroys the stream if the
 * consumer stops early.
 */
export async function* readLines(stream: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  try {
    for await (const chunk of stream) {
      buf += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
      let start = 0;
      let nl: number;
      while ((nl = buf.indexOf("\n", start)) !== -1) {
        yield stripCr(buf.slice(start, nl));
        start = nl + 1;
      }
      buf = buf.slice(start);
    }
    buf += decoder.end();
    if (buf.length > 0) yield stripCr(buf);
  } finally {
    stream.destroy();
  }
}

/** Pipes a gzipped stream through gunzip, forwarding source errors. */
export function gunzip(gz: Readable): Readable {
  const out = createGunzip();
  gz.on("error", (err) => out.destroy(err));
  out.on("close", () => gz.destroy());
  return gz.pipe(out);
}

const stripCr = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
