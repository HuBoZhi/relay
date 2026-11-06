# Larger dialog text

- Request: increase the text in the screenshot's delete-group confirmation to 13–14 px.
- Updated shared dialog descriptions, controls and buttons to 14px; labels, field hints, errors and keyboard hints to 13px. Kept the 16px title, widened the card to 480px, and allowed footer wrapping.
- Browser inspection at viewport widths 360, 900 and 1360 confirmed computed description/button size 14px, keyboard hint size 13px and no horizontal dialog overflow.
- Deployed an isolated package derived from the previously installed ASAR with only dialog.css replaced, avoiding unrelated in-progress workspace edits. Output: packages/control-room-desktop/release/20261106-dialog-fonts/win-unpacked.
- Installed app updated under D:/Programs/RelaySystem; previous exe and ASAR retained at D:/Programs/AgentRelay/data/dialog-fonts-backup-20261106. Service health and restored window verified. User groups and preferences were not changed.
