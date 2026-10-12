/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Switch, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { I18nLabel } from "./label/I18nLabel";
import { i18n } from "../../core/i18n/I18n";
import { setCookieConsent } from "../../utils/cookieConsent";

const switchSx = {
  "& .MuiSwitch-switchBase.Mui-checked": { color: "var(--accent-strong)" },
  "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { backgroundColor: "var(--accent-strong)" },
};

export type CookieConsentSettingsModalProps = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

/**
 * The "Personnaliser" destination from CookieConsentBanner — necessary cookies are locked on
 * (exempt from consent by law), other categories default off and are only ever turned on by an
 * explicit save here. Not the default first-visit experience (that stays a lightweight banner).
 * Closing (X button, Escape, backdrop click) records no consent decision — it just hands control
 * back to the banner, which keeps reappearing until an explicit choice is made.
 */
export const CookieConsentSettingsModal = ({ open, onClose, onSaved }: CookieConsentSettingsModalProps) => {
  const [audienceMeasurement, setAudienceMeasurement] = useState(false);

  const handleSave = () => {
    setCookieConsent({ necessary: true, audienceMeasurement });
    onSaved();
  };

  return (
    <Dialog open={open} maxWidth="sm" fullWidth onClose={onClose}>
      <DialogTitle sx={{ pr: 6 }}>
        <I18nLabel id="common.cookieConsent.modal.title" />
        <IconButton
          aria-label={i18n.get("common.cookieConsent.close")}
          onClick={onClose}
          sx={{ position: "absolute", top: 8, right: 8, color: "var(--accent-strong)" }}
          size="small"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">
                <I18nLabel id="common.cookieConsent.modal.necessary.label" />
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <I18nLabel id="common.cookieConsent.modal.necessary.description" />
              </Typography>
            </Stack>
            <Switch checked disabled />
          </Stack>
          <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">
                <I18nLabel id="common.cookieConsent.modal.audienceMeasurement.label" />
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <I18nLabel id="common.cookieConsent.modal.audienceMeasurement.description" />
              </Typography>
            </Stack>
            <Switch
              checked={audienceMeasurement}
              onChange={(e) => setAudienceMeasurement(e.target.checked)}
              sx={switchSx}
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={handleSave} sx={{ backgroundColor: "var(--accent-strong)", color: "var(--hero-button-text)" }}>
          <I18nLabel id="common.cookieConsent.modal.save" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default CookieConsentSettingsModal;
