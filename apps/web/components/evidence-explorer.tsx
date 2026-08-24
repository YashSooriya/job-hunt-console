"use client";

import { useMemo, useState } from "react";
import type { EvidenceItem } from "@/lib/types";

export function EvidenceExplorer({ items }: { items: EvidenceItem[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const categories = useMemo(
    () => Array.from(new Set(items.map((item) => item.category))).sort(),
    [items]
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      const categoryMatch = category === "all" || item.category === category;
      const haystack = `${item.evidenceKey} ${item.claim} ${item.detail || ""} ${item.tags.join(" ")}`.toLowerCase();
      return categoryMatch && (!q || haystack.includes(q));
    });
  }, [items, query, category]);

  return (
    <section className="card evidenceCard">
      <div className="cardHeader">
        <div>
          <h2>Evidence library</h2>
          <p>{filtered.length} of {items.length} atomic evidence records</p>
        </div>
        <div className="filterRow">
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search evidence"
            aria-label="Search evidence"
          />
          <select
            className="input"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Evidence category"
          >
            <option value="all">All categories</option>
            {categories.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
          </select>
        </div>
      </div>
      <div className="evidenceList">
        {filtered.map((item) => (
          <article className="evidenceItem" key={item.evidenceKey}>
            <div className="evidenceTop">
              <div>
                <span className="monoKey">{item.evidenceKey}</span>
                <strong>{item.claim}</strong>
              </div>
              <div className="strength" aria-label={`Evidence strength ${item.strength} of 5`}>
                {"●".repeat(item.strength)}{"○".repeat(5 - item.strength)}
              </div>
            </div>
            {item.detail ? <p>{item.detail}</p> : null}
            <div className="badges">
              <span className={`badge ${item.status === "verified" ? "review" : "action"}`}>{item.status.replace("_", " ")}</span>
              <span className="badge">{item.category.replaceAll("_", " ")}</span>
              {item.tags.slice(0, 5).map((tag) => <span className="badge" key={tag}>{tag}</span>)}
            </div>
          </article>
        ))}
        {!filtered.length ? <div className="emptyState">No evidence matches this filter.</div> : null}
      </div>
    </section>
  );
}
