export type RubikaFileType = "Image" | "Video" | "Music" | "File";

export type RubikaRequestSendFileResult = {
  uploadUrl: string;
  fileId?: string;
};

export type RubikaApiResponse<T = unknown> = {
  status?: string;
  ok?: boolean;
  data?: T;
  result?: T;
  message?: string;
};

export type RubikaUpdate = Record<string, unknown>;
