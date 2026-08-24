import { AppShell } from "@/components/app-shell";
import { MemberAdmin } from "@/components/member-admin";
import { getMembership } from "@/lib/access";
import { redirect } from "next/navigation";
export default async function MembersPage(){
  const membership=await getMembership();
  if(!membership.can_manage_members) redirect('/');
  return <AppShell><div className="pageHeader"><div><div className="eyebrow">Access administration</div><h1 className="title">Members</h1><p className="sub">Invite a small trusted group. Each member receives an isolated applicant profile, job history, documents, Gmail connection and browser sessions.</p></div></div><MemberAdmin /></AppShell>;
}
