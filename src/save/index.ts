// 存档模块的公开接口。其他层只从这里引用存档。
export {
  CODE_PREFIX,
  MAX_INFLATED_BYTES,
  PACKED_PREFIX,
  decodeSaveCode,
  decodeSaveText,
  encodeSaveCode,
  encodeSaveText,
  isPackedText,
  parseStoredSave,
  unpackSaveText,
} from './code.ts';
export type { CodeOptions, DecodeTextResult, EncodeResult } from './code.ts';
export { crc32 } from './bytes.ts';
export { CONTENT_VERSION, MAX_SAVE_CHARS, SAVE_FORMAT, SAVE_VERSION, parseSave, parseSaveData, serializeSave, validateSaveData } from './format.ts';
export type { FailureCode, FailureReason, FormatOptions, LoadedSave, ParseResult, SaveFile, SerializeResult } from './format.ts';
export { DENIED_STORAGE, MIGRATED_KEY, migrateLocalStorage, openGameStore } from './backend.ts';
export type { MigrationReport, MigrationStatus, OpenedStore, StoreEnv, StoreKind } from './backend.ts';
export { DEFAULT_DB_NAME, DEFAULT_STORE_NAME, IndexedDbStore } from './indexed-db.ts';
export type {
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbObjectStoreLike,
  IdbOpenRequestLike,
  IdbRequestLike,
  IdbTransactionLike,
  IndexedDbOptions,
} from './indexed-db.ts';
export { LocalStorageStore, isQuotaError } from './local-storage.ts';
export type { StorageLike } from './local-storage.ts';
export { MIGRATIONS, migrateSave } from './migrate.ts';
export type { MigrateResult, Migration, MigrationTable, SaveData } from './migrate.ts';
export { NON_FINITE_ALLOWED, SIM_STATE_SHAPE, STATE_CHECK } from './schema.ts';
export { DEFAULT_NAMESPACE, SLOTS, listQuarantine, loadGame, quarantinePrefix, saveGame, slotKey } from './slots.ts';
export type {
  LoadOutcome,
  LoadStatus,
  LoadedMeta,
  QuarantineEntry,
  SaveOutcome,
  SaveWarning,
  SlotFailure,
  SlotName,
  SlotOptions,
} from './slots.ts';
export { MemoryStore, StoreError } from './store.ts';
export type { KeyValueStore, StoreErrorKind } from './store.ts';
export { arr, bool, fields, int, natural, nullable, num, obj, recordOf, str } from './validate.ts';
export type { Check, Issue, Shape } from './validate.ts';
