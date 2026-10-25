# Radiology: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**The worklist and scheduling (#96, web and API):** `radiology`, in the navigation after the laboratory, behind the `radiology` switch and `imagingStudy:read`. A `DataGrid` of the hospital's imaging orders not cancelled or completed, at one stage (to schedule, which opens first, scheduled, performed and awaiting report), filtered by modality and priority on the server. To schedule is stat first, then urgent, then routine, the oldest first within each; scheduled is the soonest slot first; performed the longest waiting first. Each row names the patient (the MRN masked), the study as ordered, its modality, its priority (stat and urgent in bold), its slot in words (not scheduled, unscheduled, the slot, or when and by whom it was performed), who ordered it and when, and the doctor's instructions. Works at every width.

- **Schedule** (`imagingStudy:schedule`, to schedule only) and **Reschedule** (scheduled) open a panel in place: the patient, the modality, the priority, the current slot and the instructions, then a day (today to 90 days ahead, a date field) and a start time (a list of the day's 15-minute steps), on the hospital's clock (`zonedToUtc`). It opens on the study's own slot, or the next slot to come.
- **Unschedule** (`imagingStudy:schedule`) and **Mark as performed** (`imagingStudy:perform`) on a scheduled row are row actions with no panel; the status line says what was done or why it was refused.
- A performed study offers nothing more: its report is #97.

**Modality in the services catalog:** an imaging service has a modality (X-ray, CT, MRI, ultrasound, mammography, fluoroscopy, nuclear medicine, other), chosen on the service's form, which offers it for the category imaging only and sends `null` for none. The worklist filters on it; a service with none is "Other". Notes on that field are in `features/services`.

The endpoints are the radiology API's (`apps/api/src/features/radiology/CLAUDE.md`): `GET /radiology/worklist` and `POST /radiology/orders/{orderId}/schedule`, `/unschedule` and `/perform`.

## Decided

- **The switch is `radiology`,** the module flag the tenant config already listed.
- **Permissions follow the "Imaging (perform, report)" row of `docs/PRODUCT.md`:** `imagingStudy:read`, `imagingStudy:schedule` and `imagingStudy:perform` for the radiologist and the admin. A doctor has none of these: the consultation shows an imaging order's status (`order:read`), and its report once reporting exists (#97). The mock gives the three to its admin; the tests build the other roles with `setRolePermissions`.
- **The flow is ordered, scheduled, performed (#96),** and reported with #97. Scheduling first accepts the order; performing moves it in progress; unscheduling takes it back to the stage to schedule and leaves the order accepted (an order never goes back). Performing needs a slot first: a walk-in X-ray is scheduled for the slot under way, then performed (the API's notes say what changes if a hospital asks otherwise). The doctor may still cancel until it is performed, and the order then leaves the worklist.
- **A slot is a start time, with no room, machine or length (#96).** Two studies may share a slot, and nothing stops one machine being booked twice. Rooms with a check against double booking are a follow-up, as are a day view of the schedule and a study's length.
- **The time is chosen from a list of 15-minute steps,** not typed, so every time offered is one the API takes (422 `invalid_slot` never comes from this form); whether it has passed is the server's to say (422 `outside_window`, "That time has passed"), as the clock decides. The day is checked on the form against today to 90 days ahead at the hospital (`todayIn`), as the date field's limits do not stop a typed day.
- **The day runs to the whole of the 90th day ahead at the hospital,** which is where the API's window ends too. The times are the day's wall-clock steps: in a zone with daylight saving, a skipped hour's time is moved by the conversion and one copy of a repeated hour cannot be chosen. No hospital today is in such a zone; a list built from the day's real instants is the change when one is.
- **The panel shows the date of birth** with the name, to tell the patient apart before the study, as the laboratory's collect panel does; the list does not show it.
- **The worklist is a `GET`** with a stage, a modality, a priority and a cursor: nothing typed in it says anything about a patient. Its answer names patients (name, MRN and date of birth), so the API audits every row read. `total` comes with the first page.
- **Every POST carries an idempotency key,** one per body, so a double press schedules or performs once.
- **Refusals are said in words:** scheduling `conflict` (someone moved it meanwhile), `invalid_transition` (cancelled or performed) and `order_not_found` in the panel, which then offers nothing more to send and moves focus to the alert; `outside_window` and `invalid_slot` in the panel with the form still open for another time. Unscheduling and performing `conflict`, `invalid_transition` and `order_not_found` in the status line.
- **Focus.** The panel's heading takes focus when it opens (`usePanelFocus`), and focus goes back to the button it came from when it closes, or to the status line when that row left the stage. A row action that moves its row on is said in the status line, which takes focus if the button that had it went away.

## Mock

`mocks/handlers/radiology.ts` works the imaging orders of the clinical mock (`mockImagingOrders`; at the hospital the urgent chest X-ray `ord_h_img_1` of pth_00001) and moves them on with `moveMockOrder`, as the API does through the clinical module. It keeps at most one study per order, takes the modality from the services mock (`mockServiceModality`; the sample imaging services have the dev seed's modalities), and follows the API's rules and codes: the stages and their order, the slot steps and window, versions, idempotency keys per hospital and user. Tests read it with `mockStudies`. The clinic has radiology switched off; a test switches it on.
