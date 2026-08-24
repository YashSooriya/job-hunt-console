"use client";
import { useState } from "react";

export function CopyChatGptPrompt({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  return <button className="secondaryButton" onClick={copy}>{copied ? "Copied" : "Copy ChatGPT prep prompt"}</button>;
}
