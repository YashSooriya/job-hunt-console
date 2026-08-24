"use client";
import { usePathname } from "next/navigation";
const baseNav = [["/","Dashboard"],["/jobs","Jobs"],["/applications","Applications"],["/assessments","Assessments"],["/documents","Documents"],["/profile","Profile"],["/settings","Settings"]] as const;
export function AppNav({canManageMembers=false}:{canManageMembers?:boolean}) {
  const pathname=usePathname(); const nav=canManageMembers?[...baseNav,["/members","Members"] as const]:baseNav;
  return <nav className="nav">{nav.map(([href,label])=>{const active=href==="/"?pathname==="/":pathname.startsWith(href);return <a className={active?"active":""} href={href} key={href}><span>{label}</span></a>})}</nav>;
}
