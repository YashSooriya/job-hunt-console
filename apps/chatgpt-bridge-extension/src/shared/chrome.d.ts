type ChromePort = {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

type ChromeTab = { id?: number; url?: string; title?: string; active?: boolean; status?: string };

declare const chrome: {
  storage: { local: { get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string | string[]): Promise<void> } };
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    update(tabId: number, updateProperties: Record<string, unknown>): Promise<ChromeTab>;
    create(createProperties: Record<string, unknown>): Promise<ChromeTab>;
    reload(tabId: number): Promise<ChromeTab | void>;
    connect(tabId: number, connectInfo: { name?: string }): ChromePort;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    onUpdated: {
      addListener(listener: (tabId: number, changeInfo: { url?: string; status?: string }, tab: ChromeTab) => void): void;
      removeListener(listener: (tabId: number, changeInfo: { url?: string; status?: string }, tab: ChromeTab) => void): void;
    };
    onRemoved: { addListener(listener: (tabId: number) => void): void };
  };
  scripting: {
    executeScript(details: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
  downloads: {
    download(options: { url: string; filename?: string; saveAs?: boolean; conflictAction?: "uniquify" | "overwrite" | "prompt" }): Promise<number>;
  };
  runtime: {
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void): void };
    onConnect: { addListener(listener: (port: ChromePort) => void): void };
    onInstalled: { addListener(listener: () => void): void };
    onStartup: { addListener(listener: () => void): void };
  };
  alarms: { create(name: string, alarmInfo: { periodInMinutes: number }): Promise<void>; onAlarm: { addListener(listener: (alarm: { name: string }) => void): void } };
};
