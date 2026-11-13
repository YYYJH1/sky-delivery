// 字节、校验和与压缩的小工具：CRC-32、base64url、UTF-8，以及用平台自带的 CompressionStream 做 deflate。
// 只用浏览器和 Node 都有的接口，不引用 Node 专有的模块，两边的行为相同。

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32（IEEE 802.3）。返回无符号整数。"123456789" 的结果是 0xcbf43926。 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 无符号 32 位整数写成 8 位小写十六进制。 */
export function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** 按 UTF-8 解码。字节不合法时抛出 TypeError，不悄悄替换成乱码。 */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** 文本按 UTF-8 编码后的字节数。不分配缓冲区。 */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else {
      n += 3;
    }
  }
  return n;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

/** base64url，不带等号。字母表里没有 + / 和 .，复制粘贴时不容易被改写。 */
export function base64UrlEncode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  const push = (s: string): void => {
    chunk += s;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  };
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    push((B64[n >> 18] as string) + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    push((B64[n >> 18] as string) + B64[(n >> 12) & 63]);
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    push((B64[n >> 18] as string) + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]);
  }
  parts.push(chunk);
  return parts.join('');
}

/** 解码 base64url。出现字母表之外的字符，或长度不可能由整数个字节编出时返回 null。 */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let at = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? (B64_LOOKUP[code] as number) : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

// ---- 压缩 ----
// 只写下面几个接口里用到的方法，这样在浏览器的类型和 Node 的类型下都能通过类型检查。
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

interface ByteWriter {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
}

interface ByteTransform {
  readonly readable: { getReader(): ByteReader };
  readonly writable: { getWriter(): ByteWriter };
}

/**
 * 把输入写进转换流，同时读出结果。读写必须同时进行，否则输入大于流的缓冲时会互相等待。
 * 输出超过 maxBytes 时停止并抛出 RangeError，防止小输入解出巨大的内容。
 */
async function pump(stream: ByteTransform, input: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  const writing = writer.write(input).then(() => writer.close());
  writing.catch(() => undefined); // 读的一边先出错时，写的一边的失败不再单独报告
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.length;
      if (total > maxBytes) throw new RangeError(`output is larger than ${maxBytes} bytes`);
      chunks.push(value);
    }
    await writing;
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** deflate 压缩（zlib 格式，自带 Adler-32）。 */
export function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return pump(new CompressionStream('deflate'), bytes, Number.MAX_SAFE_INTEGER);
}

/** deflate 解压。输出超过 maxBytes 时抛出 RangeError，数据损坏时抛出流的错误。 */
export function inflate(bytes: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  return pump(new DecompressionStream('deflate'), bytes, maxBytes);
}
