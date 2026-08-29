"use client";
import { usePathname } from "next/navigation";
import { useDiagnosticsVisibility } from "@/lib/diagnostics-visibility";
const baseNav = [["/","Dashboard"],["/onboarding","Build profile"],["/jobs","Jobs"],["/applications","Applications"],["/assessments","Assessments"],["/documents","Documents"],["/profile","Profile"],["/chatgpt","ChatGPT"],["/settings","Settings"]] as const;
export function AppNav({canManageMembers=false}:{canManageMembers?:boolean}) {
  const pathname=usePathname(); const showDiagnostics=useDiagnosticsVisibility();
  const nav=[...baseNav,...(showDiagnostics?[["/diagnostics","Diagnostics"] as const]:[]),...(canManageMembers?[["/members","Members"] as const]:[])];
  return <nav className="nav">{nav.map(([href,label])=>{const active=href==="/"?pathname==="/":pathname.startsWith(href);return <a className={active?"active":""} href={href} key={href}><span>{label}</span></a>})}</nav>;
}
