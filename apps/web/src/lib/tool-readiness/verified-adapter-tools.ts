/**
 * Runtime adapters verified by the product and therefore eligible for
 * readiness. Kept outside the API route so consistency tests can compare the
 * skill surface against this source of truth.
 */
export const VERIFIED_ADAPTER_TOOL_IDS = [
  "get_user_preferences",
  "list_enabled_tools",
  "read_skill_reference",
  "bigquery_run_query",
  "calendar_list_events",
  "calendar_create_event",
  "calendar_update_event",
  "operational_case_create",
  "operational_case_update_intake",
  "operational_case_update_state",
  "operational_case_add_event",
  "operational_case_persist_comparables_analysis",
  "operational_case_register_document",
  "operational_case_list_documents",
  "operational_case_extract_document_fields",
  "notify_user",
  "telegram_send_message_to_contact",
  "gmail_send_email",
  "easybroker_search_listings",
  "easybroker_search_closed_deals",
  "bigquery_lookup_local_comparables",
  "geocode_property_address",
  "generate_document_from_template",
  "image_watermark",
  "analyze_property_images",
  "lookup_property_surroundings",
  "prepare_listing_description_draft",
  "easybroker_create_listing",
  "easybroker_upload_images",
  "easybroker_publish_listing",
  "ungga_publish_listing",
  "get_avaclick_valuation",
] as const;

export const VERIFIED_ADAPTER_TOOLS = new Set<string>(
  VERIFIED_ADAPTER_TOOL_IDS
);
