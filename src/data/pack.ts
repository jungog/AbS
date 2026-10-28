import { loadDefaultPack } from './load';

/**
 * 运行时数据包单例。
 * 配置工具导出的 JSON 覆盖 defaults/*.json 后，这里会自动生效。
 */
export const PACK = loadDefaultPack();
