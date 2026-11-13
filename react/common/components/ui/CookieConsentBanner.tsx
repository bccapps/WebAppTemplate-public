/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState } from "react";
import { Link as RouterLink, useInRouterContext } from "react-router-dom";
import { Box, Button, IconButton, Link, Paper, Stack, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { I18nLabel } from "./label/I18nLabel";
import { i18n } from "../../core/i18n/I18n";
import { CookieConsentSettingsModal } from "./CookieConsentSettingsModal";
import { COOKIE_CONSENT_CHANGED_EVENT, getCookieConsent, setCookieConsent } from "../../utils/cookieConsent";

const outlinedButtonSx = { borderColor: "var(--accent-strong)", color: "var(--accent-strong)" };
const containedButtonSx = { backgroundColor: "var(--accent-strong)", color: "var(--hero-button-text)" };

/**
 * Site-wide cookie-consent banner — mounted once from the app's PageLayout. Not a blocking
 * overlay (CNIL doesn't require blocking access to a public site for the initial choice, only
 * equal prominence between accept/reject); "Personnaliser" opens the granular, save-to-close
 * CookieConsentSettingsModal instead.
 */
export type CookieConsentBannerProps = {
  /** Route of the app's cookie policy: adds a « Learn more » link after the text. Omitted = no link. */
  policyHref?: string;
};

export const CookieConsentBanner = ({ policyHref }: CookieConsentBannerProps = {}) => {
  const [dismissed, setDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inRouter = useInRouterContext();

  // A choice made elsewhere (e.g. the « Manage my cookies » link of a footer) hides the banner at once.
  useEffect(() => {
    const onChange = () => setDismissed(true);
    window.addEventListener(COOKIE_CONSENT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(COOKIE_CONSENT_CHANGED_EVENT, onChange);
  }, []);

  if (dismissed || getCookieConsent() !== null) return null;

  const acceptAll = () => {
    setCookieConsent({ necessary: true, audienceMeasurement: true });
    setDismissed(true);
  };

  const rejectAll = () => {
    setCookieConsent({ necessary: true, audienceMeasurement: false });
    setDismissed(true);
  };

  // No choice recorded: the banner just hides for this render and comes back on the next
  // page load/visit, since getCookieConsent() still returns null.
  const closeWithoutChoice = () => setDismissed(true);

  return (
    <>
      <Paper
        elevation={8}
        sx={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: (theme) => theme.zIndex.snackbar,
          p: 2,
          pr: 5,
        }}
      >
        <IconButton
          aria-label={i18n.get("common.cookieConsent.close")}
          onClick={closeWithoutChoice}
          sx={{ position: "absolute", top: 4, right: 4, color: "var(--accent-strong)" }}
          size="small"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          sx={{ alignItems: { xs: "stretch", sm: "center" }, justifyContent: "space-between", maxWidth: 1200, mx: "auto" }}
        >
          <Box sx={{ flex: 1 }}>
            <Typography variant="body2">
              <I18nLabel id="common.cookieConsent.banner.text" />
              {policyHref && (
                <>
                  {" "}
                  <Link
                    {...(inRouter ? { component: RouterLink, to: policyHref } : { href: policyHref })}
                    color="inherit"
                    underline="always"
                  >
                    <I18nLabel id="common.cookieConsent.banner.policy" />
                  </Link>
                </>
              )}
            </Typography>
          </Box>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <Button variant="outlined" onClick={() => setSettingsOpen(true)} sx={outlinedButtonSx}>
              <I18nLabel id="common.cookieConsent.banner.customize" />
            </Button>
            <Button variant="outlined" onClick={rejectAll} sx={outlinedButtonSx}>
              <I18nLabel id="common.cookieConsent.banner.rejectAll" />
            </Button>
            <Button variant="contained" onClick={acceptAll} sx={containedButtonSx}>
              <I18nLabel id="common.cookieConsent.banner.acceptAll" />
            </Button>
          </Stack>
        </Stack>
      </Paper>
      <CookieConsentSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          setSettingsOpen(false);
          setDismissed(true);
        }}
      />
    </>
  );
};

export default CookieConsentBanner;
