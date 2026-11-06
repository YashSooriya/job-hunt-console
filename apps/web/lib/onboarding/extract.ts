import { cleanUrlValue, extractUrls } from "./value-format.ts";

function cleanLine(line: string) {
  return line.replace(/\s+/g, " ").trim().replace(/^#{1,6}\s+/, "");
}

function stripBullet(line: string) {
  return line.replace(/^[•●▪◦*-]\s*/, "").trim();
}

const sectionAliases: Record<string, string> = {
  experience: "experience",
  employment: "experience",
  "work experience": "experience",
  "professional experience": "experience",
  "work history": "experience",
  education: "education",
  qualifications: "education",
  skills: "skills",
  "technical skills": "skills",
  "core skills": "skills",
  "software skills": "skills",
  projects: "projects",
  "selected projects": "projects",
  "personal projects": "projects",
  publications: "publications",
  "conference presentations": "publications",
  "research posters": "publications",
  "selected publications": "publications",
  summary: "summary",
  profile: "summary",
  "professional summary": "summary",
  "about me": "summary",
};

type ProposalCategory = "employment" | "education" | "skill" | "project" | "publication" | "evidence";

export type ExtractedProposal = {
  category: ProposalCategory;
  claim: string;
  detail: string | null;
  tags: string[];
  locator: string;
  proposalKey: string;
  proposed: Record<string, unknown>;
};

type Period = {
  text: string;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
};

const monthNumbers: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function dateValue(value: string | undefined) {
  if (!value) return null;
  const normalized = value.trim().replace(/\./g, "").replace(/\s+/g, " ");
  const monthYear = normalized.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthYear) {
    const month = monthNumbers[monthYear[1].toLowerCase()];
    return month ? `${monthYear[2]}-${month}-01` : null;
  }
  const yearMonth = normalized.match(/^(\d{4})[-/]([01]?\d)$/);
  if (yearMonth) return `${yearMonth[1]}-${yearMonth[2].padStart(2, "0")}-01`;
  const year = normalized.match(/^(\d{4})$/);
  return year ? `${year[1]}-01-01` : null;
}

function extractPeriod(line: string): Period | null {
  const dateToken = "(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+)?\\d{4}";
  const range = new RegExp(`\\b(${dateToken})\\s*(?:-|–|—|to)\\s*(Present|Current|${dateToken})\\b`, "i").exec(line);
  if (range) {
    const current = /present|current/i.test(range[2]);
    return {
      text: range[0],
      startDate: dateValue(range[1]),
      endDate: current ? null : dateValue(range[2]),
      current,
    };
  }
  const single = new RegExp(`\\b(${dateToken})\\b`, "i").exec(line);
  if (!single) return null;
  return { text: single[0], startDate: dateValue(single[1]), endDate: null, current: false };
}

function withoutPeriod(line: string, period: Period | null) {
  return (period ? line.replace(period.text, " ") : line)
    .replace(/\s+/g, " ")
    .replace(/(?:\s*[|•·]\s*)+$/, "")
    .trim();
}

function splitRecordParts(value: string) {
  return value
    .split(/\s*(?:\||•|·)\s*|\s+@\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function looksLikeRole(value: string) {
  return /\b(engineer|developer|scientist|researcher|analyst|manager|director|lead|consultant|specialist|architect|technician|professor|lecturer|assistant|fellow|intern|student|officer|coordinator|administrator|designer|writer|editor|advisor)\b/i.test(value);
}

function inferEmployment(line: string, period: Period | null) {
  const value = withoutPeriod(stripBullet(line), period);
  const atMatch = value.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) {
    return {
      role_title: atMatch[1].trim(),
      employer: atMatch[2].trim(),
    };
  }
  const parts = splitRecordParts(value);
  if (parts.length < 2) return null;
  const firstIsRole = looksLikeRole(parts[0]);
  const secondIsRole = looksLikeRole(parts[1]);
  if (!firstIsRole && !secondIsRole) return null;
  return firstIsRole
    ? { role_title: parts[0], employer: parts[1], location: parts[2] || null }
    : { employer: parts[0], role_title: parts[1], location: parts[2] || null };
}

function looksLikeQualification(value: string) {
  return /\b(BSc|MSc|MEng|BA|MA|PhD|DPhil|HND|HNC|BEng|Bachelor|Master|Doctor|degree|diploma|GCSE|A[- ]?level|NVQ|qualification)\b/i.test(value);
}

function inferEducation(line: string, period: Period | null) {
  const value = withoutPeriod(stripBullet(line), period);
  const parts = splitRecordParts(value);
  if (parts.length < 2 && !looksLikeQualification(value)) return null;
  if (parts.length >= 2) {
    const qualificationIndex = parts.findIndex(looksLikeQualification);
    if (qualificationIndex === 0) {
      return { qualification: parts[0], institution: parts[1], location: parts[2] || null };
    }
    return { institution: parts[0], qualification: parts[qualificationIndex > 0 ? qualificationIndex : 1], location: parts[2] || null };
  }
  return { institution: value, qualification: value };
}

function inferProject(line: string) {
  const value = stripBullet(line);
  const colonIndex = value.indexOf(":");
  if (colonIndex > 2 && colonIndex < 120) {
    return { title: value.slice(0, colonIndex).trim(), description: value.slice(colonIndex + 1).trim() || null };
  }
  return { title: value, description: null };
}

function meaningfulClaim(line: string) {
  const claim = stripBullet(line);
  if (claim.length < 12 || claim.length > 1000) return null;
  if (/^(profile|summary|about me|additional information|interests|references|curriculum vitae|resume)$/i.test(claim)) return null;
  return claim;
}

function addProposal(
  proposals: ExtractedProposal[],
  seen: Set<string>,
  category: ProposalCategory,
  claim: string,
  detail: string | null,
  tags: string[],
  locator: string,
  proposed: Record<string, unknown>,
) {
  const key = `${category}:${claim.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  proposals.push({
    category,
    claim,
    detail,
    tags,
    locator,
    proposalKey: `${category}_${String(proposals.length + 1).padStart(3, "0")}`,
    proposed: { claim, detail, tags, category, ...proposed },
  });
}

function skillParts(line: string) {
  const value = stripBullet(line);
  if (value.length > 500 || /[.!?]\s/.test(value)) return [];
  return value
    .split(/[,;|/]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 120)
    .slice(0, 30);
}

function isStructuredProfileJson(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return false;

  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || "",
  ];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  return candidates.some((candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return Boolean(
        parsed
        && typeof parsed === "object"
        && !Array.isArray(parsed)
        && parsed.profile
        && typeof parsed.profile === "object"
        && !Array.isArray(parsed.profile),
      );
    } catch {
      return false;
    }
  });
}

export function extractSourceProposals(raw: string): ExtractedProposal[] {
  // A structured ChatGPT profile must be parsed by the structured importer.
  // Never fall through to line/chunk extraction: that would turn JSON syntax
  // into a misleading evidence claim when the structured parser is unavailable.
  if (isStructuredProfileJson(raw)) return [];

  const lines = raw.split(/\r?\n/).map(cleanLine).filter(Boolean);
  let section = "general";
  const proposals: ExtractedProposal[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = line.toLowerCase().replace(/[:\s]+$/, "");
    const nextSection = sectionAliases[normalized];
    if (nextSection) {
      section = nextSection;
      continue;
    }

    const claim = meaningfulClaim(line);
    if (!claim) continue;
    const period = extractPeriod(claim);
    const locator = `line:${index + 1}`;

    if (section === "skills") {
      const parts = skillParts(claim);
      if (parts.length) {
        for (const name of parts) {
          addProposal(proposals, seen, "skill", name, null, ["skill"], locator, { name, category: "skill" });
        }
        continue;
      }
    }

    if (section === "experience") {
      const employment = inferEmployment(claim, period);
      if (employment) {
        const detail = lines[index + 1] && /^[•●▪◦*-]\s*/.test(lines[index + 1]) ? stripBullet(lines[index + 1]) : null;
        addProposal(proposals, seen, "employment", claim, detail, ["employment", "experience"], locator, {
          ...employment,
          location: employment.location || null,
          start_date: period?.startDate || null,
          end_date: period?.endDate || null,
          current: period?.current || false,
          period_text: period?.text || null,
          details: detail,
        });
        continue;
      }
    }

    if (section === "education") {
      const education = inferEducation(claim, period);
      if (education) {
        addProposal(proposals, seen, "education", claim, null, ["education"], locator, {
          ...education,
          start_date: period?.startDate || null,
          end_date: period?.endDate || null,
          current: period?.current || false,
          period_text: period?.text || null,
        });
        continue;
      }
    }

    if (section === "projects") {
      const project = inferProject(claim);
      addProposal(proposals, seen, "project", claim, project.description, ["project"], locator, project);
      continue;
    }

    if (section === "publications") {
      addProposal(proposals, seen, "publication", claim, null, ["publication"], locator, {
        title: claim,
        publication_type: "publication",
      });
      continue;
    }

    const detail = section === "summary" ? claim : null;
    addProposal(proposals, seen, "evidence", claim, detail, [section === "general" ? "profile" : section], locator, {});
  }

  if (!proposals.length && raw.trim().length >= 20) {
    const chunks = raw.trim().match(/.{1,900}(?:\s|$)/g) || [raw.trim().slice(0, 900)];
    for (const [chunkIndex, chunk] of chunks.slice(0, 20).entries()) {
      const claim = cleanLine(chunk);
      if (claim.length >= 12) addProposal(proposals, seen, "evidence", claim, null, ["profile", "user_description"], `chunk:${chunkIndex + 1}`, {});
    }
  }

  return proposals.slice(0, 180);
}

// Kept as a compatibility alias for existing callers and verification scripts.
export function extractCvProposals(raw: string) {
  return extractSourceProposals(raw);
}

export function extractSimpleFacts(raw: string) {
  const facts: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  const add = (key: string, value: string | null | undefined) => {
    const normalized = value?.trim();
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    facts.push({ key, value: normalized });
  };

  const urls = extractUrls(raw);
  add("email", raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase());
  add("phone", raw.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d(?:[\s.-]?\d){7,12}/)?.[0]);
  add("linkedin_url", cleanUrlValue(urls.find((url) => /linkedin\.com/i.test(url))));
  add("github_url", cleanUrlValue(urls.find((url) => /github\.com/i.test(url))));
  add("portfolio_links", cleanUrlValue(urls.find((url) => !/linkedin\.com|github\.com/i.test(url))));
  return facts;
}
