import type { Entity } from "@emulators/core";

export interface GoogleUser extends Entity {
  uid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  picture: string | null;
  email_verified: boolean;
  locale: string;
  hd: string | null;
}

export interface GoogleOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

export interface GoogleMessage extends Entity {
  gmail_id: string;
  thread_id: string;
  user_email: string;
  history_id: string;
  internal_date: string;
  raw: string | null;
  label_ids: string[];
  snippet: string;
  subject: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  message_id: string;
  references: string | null;
  in_reply_to: string | null;
  date_header: string;
  body_text: string | null;
  body_html: string | null;
}

export interface GoogleDraft extends Entity {
  gmail_id: string;
  user_email: string;
  message_gmail_id: string;
}

export interface GoogleAttachment extends Entity {
  gmail_id: string;
  user_email: string;
  message_gmail_id: string;
  filename: string;
  mime_type: string;
  disposition: string | null;
  content_id: string | null;
  transfer_encoding: string | null;
  data: string;
  size: number;
}

export interface GoogleHistoryEvent extends Entity {
  gmail_id: string;
  user_email: string;
  change_type: "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";
  message_gmail_id: string;
  thread_id: string;
  label_ids: string[];
}

export interface GoogleLabel extends Entity {
  gmail_id: string;
  user_email: string;
  name: string;
  type: "system" | "user";
  message_list_visibility: string | null;
  label_list_visibility: string | null;
  color_background: string | null;
  color_text: string | null;
}

export interface GoogleFilter extends Entity {
  gmail_id: string;
  user_email: string;
  criteria_from: string | null;
  add_label_ids: string[];
  remove_label_ids: string[];
}

export interface GoogleForwardingAddress extends Entity {
  user_email: string;
  forwarding_email: string;
  verification_status: string;
}

export interface GoogleSendAs extends Entity {
  user_email: string;
  send_as_email: string;
  display_name: string | null;
  is_default: boolean;
  signature: string;
}

export interface GoogleCalendar extends Entity {
  google_id: string;
  user_email: string;
  summary: string;
  description: string | null;
  time_zone: string;
  primary: boolean;
  selected: boolean;
  access_role: string;
  background_color: string | null;
  foreground_color: string | null;
}

export interface GoogleCalendarEventAttendee {
  email: string;
  display_name: string | null;
  response_status: string | null;
  organizer: boolean;
  self: boolean;
}

export interface GoogleCalendarConferenceEntryPoint {
  entry_point_type: string;
  uri: string;
  label: string | null;
}

export interface GoogleCalendarEventReminderOverride {
  method: string;
  minutes: number;
}

export interface GoogleCalendarEventReminders {
  use_default: boolean;
  overrides: GoogleCalendarEventReminderOverride[];
}

export interface GoogleCalendarEvent extends Entity {
  google_id: string;
  revision?: number;
  user_email: string;
  calendar_google_id: string;
  status: string;
  summary: string;
  description: string | null;
  location: string | null;
  html_link: string | null;
  hangout_link: string | null;
  start_date_time: string | null;
  start_date: string | null;
  start_time_zone?: string | null;
  end_date_time: string | null;
  end_date: string | null;
  end_time_zone?: string | null;
  attendees: GoogleCalendarEventAttendee[];
  conference_entry_points: GoogleCalendarConferenceEntryPoint[];
  transparency: string | null;
  reminders?: GoogleCalendarEventReminders | null;
}

export interface GoogleDriveItem extends Entity {
  google_id: string;
  user_email: string;
  name: string;
  mime_type: string;
  description?: string | null;
  parent_google_ids: string[];
  web_view_link: string | null;
  size: number | null;
  starred?: boolean;
  trashed: boolean;
  drive_google_id?: string | null;
  owners?: Array<{
    email_address: string;
    display_name: string | null;
  }>;
  data: string | null;
}

export interface GoogleDrivePermission extends Entity {
  google_id: string;
  user_email: string;
  file_google_id: string;
  role: string;
  permission_type: string;
  email_address: string | null;
  display_name: string | null;
}

export interface GoogleSharedDrive extends Entity {
  google_id: string;
  name: string;
  member_emails: string[];
}

export interface GoogleDocument extends Entity {
  google_id: string;
  user_email: string;
  body: string;
  revision_id: string;
}

export interface GoogleSheet {
  sheet_id: number;
  title: string;
  index: number;
  row_count: number;
  column_count: number;
  values: unknown[][];
}

export interface GoogleSpreadsheet extends Entity {
  google_id: string;
  user_email: string;
  sheets: GoogleSheet[];
}

export interface GoogleSlideElement {
  object_id: string;
  element_type: "shape" | "image";
  shape_type: string | null;
  placeholder_type: string | null;
  text: string;
  image_url: string | null;
  size: Record<string, unknown> | null;
  transform: Record<string, unknown> | null;
  text_style: Record<string, unknown>;
  paragraph_style: Record<string, unknown>;
}

export interface GoogleSlide {
  object_id: string;
  layout_object_id: string;
  page_elements: GoogleSlideElement[];
}

export interface GooglePresentation extends Entity {
  google_id: string;
  user_email: string;
  revision_id: string;
  slides: GoogleSlide[];
}
