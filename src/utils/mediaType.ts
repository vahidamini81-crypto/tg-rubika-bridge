import type { NormalizedMessageType } from "../types/bridge.js";
import type { RubikaFileType } from "../types/rubika.js";

export function toRubikaFileType(type: NormalizedMessageType): RubikaFileType {
  switch (type) {
    case "photo":
      return "Image";
    case "video":
    case "animation":
      return "Video";
    case "audio":
    case "voice":
      return "Music";
    case "document":
    default:
      return "File";
  }
}

export function isMediaMessage(type: NormalizedMessageType): boolean {
  return ["photo", "document", "video", "animation", "audio", "voice"].includes(type);
}
