"use client";

import { useState } from "react";

export function CopyDocumentTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    setCopied(false); setError("");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("Clipboard unavailable. Select the text and copy it manually.");
    }
  }
  return <div className="copyDocumentText">
    <button className="textLink" type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy cover letter"}</button>
    {error ? <small role="status">{error}</small> : null}
  </div>;
}
