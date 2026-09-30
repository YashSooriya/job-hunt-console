import { redirect } from "next/navigation";

/** Keep old bookmarks useful without presenting the retired plugin setup. */
export default function RetiredChatGptConnectionPage() {
  redirect("/settings#chatgpt-bridge");
}
