import crypto from "node:crypto";

const sensitivePattern = /(password|passcode|security answer|social security|national insurance|passport|date of birth|birth date|gender|sex|ethnicity|race|religion|disability|veteran|criminal|conviction|sexual orientation|political|trade union|clearance|citizenship|nationality)/i;

export async function observePage(page) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  let ariaSnapshot = null;
  try {
    ariaSnapshot = await page.locator("body").ariaSnapshot({ mode: "ai", depth: 12 });
  } catch {
    try { ariaSnapshot = await page.locator("body").ariaSnapshot(); } catch {}
  }

  const raw = await page.evaluate(() => {
    const visible = (el) => {
      const s = getComputedStyle(el); const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity || 1) !== 0 && r.width > 0 && r.height > 0;
    };
    const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
    const ownLabelFor = (el) => {
      if (el.tagName === "BUTTON" && text(el)) return text(el);
      if (el.tagName === "INPUT" && ["submit","button","reset"].includes((el.type || "").toLowerCase()) && el.value) return el.value;
      const id = el.id;
      if (id) {
        const direct = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (direct && text(direct)) return text(direct);
      }
      const wrapped = el.closest("label");
      if (wrapped && text(wrapped)) return text(wrapped);
      const labelled = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((x) => text(document.getElementById(x))).filter(Boolean).join(" ");
      if (labelled) return labelled;
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      return el.getAttribute("placeholder") || el.getAttribute("name") || "";
    };
    const groupLabelFor = (el) => {
      const fieldset = el.closest("fieldset");
      const legend = fieldset?.querySelector(":scope > legend");
      if (legend && text(legend)) return text(legend);
      const group = el.closest('[role="radiogroup"], [role="group"]');
      if (group) {
        const labelled = (group.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((x) => text(document.getElementById(x))).filter(Boolean).join(" ");
        if (labelled) return labelled;
        const aria = group.getAttribute("aria-label");
        if (aria) return aria;
      }
      return "";
    };
    const labelFor = (el) => {
      const own = ownLabelFor(el);
      if ((el.type || "").toLowerCase() === "radio") return groupLabelFor(el) || own || el.getAttribute("name") || "radio";
      if (own) return own;
      const parentText = text(el.parentElement);
      return parentText.slice(0, 180) || el.tagName.toLowerCase();
    };
    const controlType = (el) => {
      const role = el.getAttribute("role");
      if (role === "combobox") return "combobox";
      if (role === "radio") return "radio";
      if (role === "checkbox") return "checkbox";
      if (el.tagName === "TEXTAREA") return "textarea";
      if (el.tagName === "SELECT") return "select";
      if (el.tagName === "BUTTON" || (el.tagName === "INPUT" && ["submit","button","reset"].includes((el.type || "").toLowerCase()))) return "button";
      if (el.tagName === "INPUT") {
        const t = (el.type || "text").toLowerCase();
        if (t === "file") return "file";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (["date","month","week"].includes(t)) return "date";
        if (["number","range"].includes(t)) return "number";
        return "text";
      }
      if (el.isContentEditable) return "textarea";
      return "other";
    };
    const elements = [...document.querySelectorAll('input, textarea, select, button, [role="combobox"], [role="checkbox"], [role="radio"], [contenteditable="true"]')]
      .filter((el) => visible(el) && !["hidden"].includes((el.type || "").toLowerCase()));
    const controls = elements.map((el, index) => {
      const type = controlType(el); const label = labelFor(el);
      let value = null; let hasValue = false;
      if (type === "checkbox" || type === "radio") { value = Boolean(el.checked || el.getAttribute("aria-checked") === "true"); hasValue = Boolean(value); }
      else if (type === "select") { value = el.value || null; hasValue = Boolean(el.value); }
      else if (type === "file") { value = el.files?.length ? `${el.files.length} file(s)` : null; hasValue = Boolean(el.files?.length); }
      else { value = el.value ?? el.textContent ?? null; hasValue = Boolean(String(value || "").trim()); }
      const options = type === "select" ? [...el.options].map((o) => ({ label: text(o), value: o.value })) : [];
      const locator = {
        id: el.id || null,
        name: el.getAttribute("name") || null,
        ariaLabel: el.getAttribute("aria-label") || null,
        placeholder: el.getAttribute("placeholder") || null,
        role: el.getAttribute("role") || null,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        value: el.getAttribute("value") || null,
        index,
      };
      return {
        fieldKey: `f${index + 1}`,
        label,
        name: locator.name,
        id: locator.id,
        role: locator.role,
        controlType: type,
        required: Boolean(el.required || el.getAttribute("aria-required") === "true" || /\*/.test(label)),
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        visible: true,
        currentValue: value,
        hasValue,
        options,
        locator,
        autocomplete: el.getAttribute("autocomplete") || null,
        placeholder: locator.placeholder,
        optionLabel: type === "radio" ? ownLabelFor(el) : null,
        optionValue: type === "radio" ? (el.getAttribute("value") || ownLabelFor(el) || null) : null,
      };
    });
    const bodyText = text(document.body).slice(0, 16000);
    return { controls, bodyText };
  });

  const controls = raw.controls.map((control) => {
    const sensitive = sensitivePattern.test(`${control.label} ${control.name || ""} ${control.autocomplete || ""}`) || /password/i.test(control.locator?.type || "");
    if (sensitive && control.hasValue) return { ...control, sensitive: true, currentValue: null };
    return { ...control, sensitive };
  });
  const text = `${title} ${raw.bodyText}`;
  const flags = {
    captcha: /captcha|recaptcha|hcaptcha|i am not a robot/i.test(text),
    mfa: /verification code|one.?time code|two.?factor|multi.?factor|authenticator code/i.test(text),
    authentication: /sign in|log in|login/i.test(text) && controls.some((c) => /password/i.test(c.locator?.type || "") || /password/i.test(c.label)),
  };
  const fingerprintPayload = JSON.stringify({ url, title, controls: controls.map(({ fieldKey,label,name,id,role,controlType,required,options }) => ({ fieldKey,label,name,id,role,controlType,required,options })) });
  const fingerprint = crypto.createHash("sha256").update(fingerprintPayload).digest("hex");
  return { url, title, bodyText: raw.bodyText, ariaSnapshot, controls, flags, fingerprint };
}
