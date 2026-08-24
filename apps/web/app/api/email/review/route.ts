import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body=await request.json();
    const supabase=await createClient();
    const { data: user }=await supabase.auth.getUser(); if(!user.user) return NextResponse.json({error:"Authentication required"},{status:401});
    if(!body.emailId||!body.applicationId||!body.classification) return NextResponse.json({error:"Email, application and classification are required."},{status:400});
    const {data,error}=await supabase.rpc("resolve_application_email",{p_email_id:body.emailId,p_application_id:body.applicationId,p_classification:body.classification});
    if(error) return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json(data);
  } catch(error:any){return NextResponse.json({error:error?.message||"Could not resolve email"},{status:500});}
}
