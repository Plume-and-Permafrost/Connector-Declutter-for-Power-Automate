# Store listing

Copy for the Chrome Web Store and Firefox Add-ons (AMO) listings. Both fields are
plain text in the stores, so each is kept in a code block to paste as-is.

## Summary

129 characters. Chrome's limit is 132 and it uses the manifest `description`, so
keep this in step with `manifest.json` and `manifest.firefox.json`. AMO allows 250.

```
Hides DLP-blocked, desktop and agent connectors in the Power Automate designer, so the action picker lists only what you can use.
```

## Description

Only the first 250 characters show before "Read more", so the opening paragraph
carries the main points.

```
Power Automate's "Add an action" panel shows every connector in the catalogue, including ones your organisation's DLP (data loss prevention) policy blocks. You only find out when saving fails. Connector Declutter hides those connectors so you only see the ones you can use.

**WHAT IT DOES**
• Hides connectors blocked by your tenant's DLP policies, per environment
• Hides MCP, agent and Copilot connectors, and desktop connectors (on by default, no setup needed)
• Adds three filter pills next to the designer's All / Built-in / Shared / Custom:
   – Microsoft: Microsoft's own products and built-in connectors
   – My Filter: connectors you pick in Settings
   – In Flow: connectors the open flow already uses
• Search, paging and result counts stay consistent because filtering happens before the panel shows anything
• Optional colour coding of connectors by DLP classification (Business / Non-business)
• Optional layout tweaks: hide the Favourites, AI capabilities or Built-in tools sections, open Favourites automatically, and stop rows jumping on hover
• If it can't tell whether a connector is blocked, it leaves it visible. Custom connectors, built-ins and connectors newer than your policy data are never hidden by the DLP filter

**IMPORTING YOUR DLP POLICIES**
The desktop and agent filters work as soon as the extension is installed. To hide DLP-blocked connectors, the extension needs your tenant's policy data. There are four ways to provide it:

1. From the Power Platform admin centre (recommended; needs permission to view DLP policies)
   a. Sign in to https://admin.powerplatform.microsoft.com
   b. Open Policies → Data policies
   c. When the page loads, a prompt appears offering to import your DLP policies. Click Import
   d. Open or reload a flow in https://make.powerautomate.com. Blocked connectors are now hidden
   Visiting the Data policies page again later updates the stored policies without prompting.

2. Automatically (opt-in)
   a. Click the extension icon → Settings
   b. Turn on "Fetch DLP policies automatically"
   c. Open Power Automate as usual. The extension reuses the sign-in the portal already has to read the policies. The token is never stored and never leaves the page. This only works for accounts that can read DLP policies.

3. From a colleague's export (for non-admins)
   a. Ask an admin to set up the extension using option 1, then click Settings → Export configuration and send you the file
   b. In your copy, click Settings → Import configuration… and choose the file
   You get the same filtering without needing any admin access.

4. By hand
   In Settings → "Import a policy by hand", paste a /v1/policies response from the Power Platform governance API, a single policy, or a plain list of connector IDs to block, then click Import.

**PRIVACY**
Policy data and settings are stored only in your browser. The extension has no server, collects no data and runs only on make.powerautomate.com and admin.powerplatform.microsoft.com. It does not check for updates on a schedule; it only refreshes policies when they are already on screen or when you have turned on auto-fetch.

Not affiliated with or endorsed by Microsoft. Power Automate and Power Platform are trademarks of Microsoft Corporation.
```
