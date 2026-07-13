/**
 * Runtime environment detection. The same panel code runs in two hosts:
 * - 'extension': Chrome MV3 side panel (chrome.* available)
 * - 'page': mounted directly into the user's dev app via `init()` from the npm
 *   package — works in ANY browser (Safari, Firefox, Chrome, …), no extension APIs.
 */
export const isExtensionContext: boolean =
  typeof chrome !== 'undefined' && !!chrome.runtime?.id && !!chrome.storage?.local;
