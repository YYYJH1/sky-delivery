// 导出码：把存档压缩后编码成一串可以复制的字符，带前缀和校验和。
//   SKYSAVE1.<base64url(deflate(存档文本))>.<压缩数据的 CRC-32，8 位十六进制>
// 导入时先核对校验和，再解压、校验、迁移，所以复制时漏了字符或被改过，会在最前面就被发现。
// 压缩用平台自带的 CompressionStream，Node 和浏览器里都有。
//
// 存储里的存档也用这种写法：写进存储的存档文本先压缩，读出来时解压，见文件末尾的 parseStoredSave。
// 存储里的存档文本有两种，靠开头的字符区分，这就是「是否压缩」的标记：
//   以 { 开头的是 JSON 原文，版本 1 的存档都是这样存的，没有压缩，读档照常能读。
//   以 SKYSAVE1. 开头的是压缩之后的写法，和导出码完全相同，所以导出存档时可以直接拿存储里的文本。
import type { SimState } from '../core/index.ts';
import { base64UrlDecode, base64UrlEncode, crc32, deflate, hex8, inflate, utf8Decode, utf8Encode } from './bytes.ts';
import { failure, parseSave, serializeSave } from './format.ts';
import type { FailureReason, FormatOptions, ParseResult } from './format.ts';

/** 导出码的前缀。编码方式有不兼容的改动时，把末尾的数字加一。 */
export const CODE_PREFIX = 'SKYSAVE1';

/** 解压后最大的字节数。更大的按解压失败处理，防止一小段数据解出巨大的内容。 */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export type EncodeResult = { ok: true; code: string } | { ok: false; reason: FailureReason };

/** 把一份存档文本编成导出码。文本应当是 serializeSave 或存储里读出来的、已经校验过的存档。 */
export async function encodeSaveText(text: string): Promise<string> {
  const packed = await deflate(utf8Encode(text));
  return `${CODE_PREFIX}.${base64UrlEncode(packed)}.${hex8(crc32(packed))}`;
}

/** 把状态编成导出码。状态不通过校验，或者环境里没有 CompressionStream（很旧的浏览器）时返回失败，不生成导出码。 */
export async function encodeSaveCode(state: SimState, savedAtMs: number, options: FormatOptions = {}): Promise<EncodeResult> {
  const serialized = serializeSave(state, savedAtMs, options);
  if (!serialized.ok) return serialized;
  try {
    return { ok: true, code: await encodeSaveText(serialized.text) };
  } catch (error) {
    return failure('serialize', `the save could not be compressed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type DecodeTextResult = { ok: true; text: string } | { ok: false; reason: FailureReason };

/** 导出码还原成存档文本：核对前缀和校验和，再解压。空白（包括换行）会先被去掉，粘贴时被折行也没关系。 */
export async function decodeSaveText(code: string, maxInflatedBytes: number = MAX_INFLATED_BYTES): Promise<DecodeTextResult> {
  if (typeof code !== 'string') return failure('code', 'the save code must be text');
  const parts = code.replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) {
    return failure('code', `not a save code, expected ${CODE_PREFIX}.<data>.<checksum>`);
  }
  const body = parts[1] as string;
  const sum = parts[2] as string;
  if (!/^[0-9a-fA-F]{8}$/.test(sum)) return failure('code', 'the checksum must be 8 hexadecimal digits');
  const packed = base64UrlDecode(body);
  if (packed === null || packed.length === 0) return failure('code', 'the data part is not valid base64url');
  if (crc32(packed) !== Number.parseInt(sum, 16)) {
    return failure('checksum', 'the checksum does not match, the code was changed or copied incompletely');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await inflate(packed, maxInflatedBytes);
  } catch (error) {
    return failure('inflate', `the data could not be decompressed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { ok: true, text: utf8Decode(bytes) };
  } catch {
    return failure('inflate', 'the decompressed data is not valid UTF-8 text');
  }
}

export interface CodeOptions extends FormatOptions {
  /** 解压后最大的字节数。默认 MAX_INFLATED_BYTES。 */
  maxInflatedBytes?: number;
}

/** 导入导出码：核对校验和，解压，解析，迁移，校验。结果和读存档相同。 */
export async function decodeSaveCode(code: string, options: CodeOptions = {}): Promise<ParseResult> {
  const decoded = await decodeSaveText(code, options.maxInflatedBytes);
  if (!decoded.ok) return decoded;
  return parseSave(decoded.text, options);
}

// ---- 存储里的存档 ----

/** 存储里压缩写法的开头。 */
export const PACKED_PREFIX = `${CODE_PREFIX}.`;

/** 这段存档文本是不是压缩之后的写法。 */
export function isPackedText(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(PACKED_PREFIX);
}

/**
 * 存储里的存档文本还原成 JSON 原文。压缩的先核对校验和再解压，没有压缩的原样返回。
 * 压缩数据被改过、截断或解压失败时，返回 code、checksum、inflate 三种失败之一，不抛出。
 */
export async function unpackSaveText(stored: string, maxInflatedBytes: number = MAX_INFLATED_BYTES): Promise<DecodeTextResult> {
  if (typeof stored !== 'string') return failure('format', 'a stored save must be text');
  if (!isPackedText(stored)) return { ok: true, text: stored };
  return decodeSaveText(stored, maxInflatedBytes);
}

/** 解析存储里的一份存档，压缩的和没有压缩的都能读。结果和 parseSave 相同。 */
export async function parseStoredSave(stored: string, options: CodeOptions = {}): Promise<ParseResult> {
  const unpacked = await unpackSaveText(stored, options.maxInflatedBytes);
  if (!unpacked.ok) return unpacked;
  return parseSave(unpacked.text, options);
}
