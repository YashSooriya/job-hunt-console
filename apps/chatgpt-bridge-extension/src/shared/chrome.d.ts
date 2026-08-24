type ChromeTab = { id?: number; url?: string; title?: string; active?: boolean; status?: string };

declare const chrome: {
  storage: { local: { get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string | string[]): Promise<void> } };
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    update(tabId: number, updateProperties: Record<string, unknown>): Promise<ChromeTab>;
    create(createProperties: Record<string, unknown>): Promise<ChromeTab>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  runtime: {
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void): void };
    onInstalled: { addListener(listener: () => void): void };
    onStartup: { addListener(listener: () => void): void };
  };
  alarms: { create(name: string, alarmInfo: { periodInMinutes: number }): Promise<void>; onAlarm: { addListener(listener: (alarm: { name: string }) => void): void } };
};
