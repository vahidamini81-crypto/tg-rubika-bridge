export type NormalizedMessageType =
  | "text"
  | "photo"
  | "document"
  | "video"
  | "animation"
  | "audio"
  | "voice"
  | "unsupported";

export type NormalizedMessage = {
  sourcePlatform: "telegram";
  telegramUpdateId: number;
  sourceChatId: string;
  sourceMessageId?: number;
  telegramUserId?: number;
  senderDisplayName?: string;
  type: NormalizedMessageType;
  text?: string;
  caption?: string;
  telegramFileId?: string;
  originalFilename?: string;
  mimeType?: string;
  fileSize?: number;
  isForwarded: boolean;
  statusMessageId?: string;
};
