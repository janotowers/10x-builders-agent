import { redirect } from "next/navigation";

export default function ToolRequestsPage() {
  redirect("/settings?view=capabilities&section=requests#tool-requests");
}
