# PRD: Castle Garage Doors Online Scheduler

## 1. Overview

Castle Garage Doors needs a mobile-friendly online scheduling tool that allows customers to quickly book garage door and gate service appointments.

The desired flow should be similar to A1 Garage Door’s scheduler: simple, guided, low-friction, and not overly diagnostic. The scheduler should capture the customer’s ZIP code, name, and mobile phone early, so Castle can follow up if the customer abandons the flow before completing the booking.

The scheduler should support both:

- Garage door services
- Gate services

The scheduler should avoid requiring customers to self-diagnose technical problems such as broken springs, cables, sensors, etc. Instead, it should ask simple, broad questions that help dispatch prepare for the appointment.

---

## 2. Goals

### Primary Goals

- Allow customers to book service online quickly.
- Capture partial leads early in the flow.
- Support garage door and gate workflows.
- Keep the experience simple and mobile-first.
- Capture enough information for dispatch and technicians to prepare.
- Reduce abandoned bookings by saving customer contact information early.
- Make optional photo or note submission available without creating friction.

### Non-Goals

- Do not create a full diagnostic troubleshooting tool.
- Do not force SMS verification.
- Do not require photos.
- Do not require customers to know specific part failures.
- Do not ask for full address before basic lead capture.

---

## 3. User Flow Summary

```text
START
│
├── Step 1: ZIP / Postal Code
│
├── Step 2: First Name + Mobile Phone
│
├── Step 3: Service Selection
│   ├── Garage Door
│   │   ├── Repairs & Service
│   │   ├── Door / Panel Replacement
│   │   └── Opener Service / Replacement
│   │
│   └── Gate
│       ├── Repairs & Service
│       ├── Gate Opener Service / Replacement
│       └── New Gate / Gate Replacement
│
├── Step 4: Optional Details
│   ├── Upload photos
│   ├── Add note
│   └── Skip
│
├── Step 5: Choose Appointment
│
├── Step 6: Property Details
│
├── Step 7: Review & Confirm
│
└── Step 8: Confirmation
```

---

## 4. Detailed Requirements

## Step 1: Service Area Check

### Screen Title

```text
Enter your ZIP or postal code
```

### Subtext

```text
So we can check if we service your area.
```

### Input

- ZIP / Postal Code

### Validation

- Required field
- Numeric ZIP validation for U.S. ZIP codes
- Check ZIP against Castle service area list

### If ZIP is serviceable

Continue to Step 2.

### If ZIP is not serviceable

Show:

```text
Sorry, we do not currently service your area.
```

Optional CTA:

```text
You can still call us at (800) 576-1397 and we’ll see if we can help.
```

### Backend Requirements

Save:

- ZIP code
- Timestamp
- UTM/source/campaign attribution, if available
- Session ID

---

## Step 2: Lead Capture

### Screen Title

```text
Let’s get your appointment started
```

### Inputs

- First Name
- Mobile Phone Number

### Subtext

```text
We’ll only contact you about your appointment.
```

### Validation

- First name required
- Mobile phone required
- Format phone number live, example: `(760) 555-1234`
- Reject obviously invalid phone numbers

### Important UX Requirements

- Do not require SMS verification.
- Do not ask for last name yet.
- Do not ask for email yet.
- Do not ask for full address yet.

### Backend Requirements

Upon successful completion of this step, create or update a partial lead.

Save:

- ZIP code
- First name
- Mobile phone
- Session ID
- Source / campaign attribution
- Current funnel step
- Timestamp

This lead should be available for abandoned booking follow-up if the customer does not complete the flow.

---

## Step 3: Service Selection

### Screen Title

```text
What do you need help with?
```

### Primary Options

```text
Garage Door
Gate
```

---

# Branch A: Garage Door

## Step 3A: Garage Door Service Type

### Screen Title

```text
Please select your service
```

### Options

```text
Repairs & Service
Door / Panel Replacement
Opener Service / Replacement
```

---

## If Garage Door → Repairs & Service

### Question 1

```text
Are you able to open and close your door?
```

### Options

```text
Yes
No
```

### Question 2

```text
What is the estimated age of your garage door?
```

### Options

```text
Less than 8 years old
8 years or older
Not sure
```

Continue to Step 4.

---

## If Garage Door → Door / Panel Replacement

### Question 1

```text
What type of door are you looking for?
```

### Options

```text
Something Basic and Functional
Something Nicer with More Features
Not sure
```

### Question 2

```text
What is the estimated age of your garage door?
```

### Options

```text
Less than 8 years old
8 years or older
Not sure
```

### Question 3

```text
Do you have more than one garage door?
```

### Options

```text
Yes
No
```

Continue to Step 4.

---

## If Garage Door → Opener Service / Replacement

### Question 1

```text
What do you need help with?
```

### Options

```text
Repair existing opener
Replace opener
Add opener to existing door
Not sure
```

### Question 2

```text
Is your garage door able to open and close?
```

### Options

```text
Yes
No
```

Continue to Step 4.

---

# Branch B: Gate

## Step 3B: Gate Service Type

### Screen Title

```text
Please select your service
```

### Options

```text
Repairs & Service
Gate Opener Service / Replacement
New Gate / Gate Replacement
```

---

## If Gate → Repairs & Service

### Question 1

```text
Is your gate able to open and close?
```

### Options

```text
Yes
No
```

### Question 2

```text
What type of gate do you have?
```

### Options

```text
Swing Gate
Sliding Gate
Not sure
```

Continue to Step 4.

---

## If Gate → Gate Opener Service / Replacement

### Question 1

```text
What do you need help with?
```

### Options

```text
Repair existing opener
Replace opener
Add opener to existing gate
Not sure
```

### Question 2

```text
Is your gate able to open and close?
```

### Options

```text
Yes
No
```

### Question 3

```text
What type of gate do you have?
```

### Options

```text
Swing Gate
Sliding Gate
Not sure
```

Continue to Step 4.

---

## If Gate → New Gate / Gate Replacement

### Question 1

```text
What type of gate are you looking for?
```

### Options

```text
Something Basic and Functional
Something Nicer with More Features
Not sure
```

### Question 2

```text
What type of gate do you need?
```

### Options

```text
Swing Gate
Sliding Gate
Pedestrian Gate
Not sure
```

Continue to Step 4.

---

## Step 4: Optional Details

This entire step is optional.

### Screen Title

```text
Want to tell us more?
```

### Subtext

```text
This step is optional, but it can help our technicians prepare.
```

### Inputs

- Photo upload
- Short note text field

### Text Field Placeholder

```text
Anything else you'd like us to know?
```

### Helper Text

```text
Examples: the door is stuck open, the opener is making noise, the gate only works sometimes, or you’d like a quote for replacement.
```

### Rules

- Customer may upload photos, add text, do both, or skip.
- Do not require a photo.
- Do not require a note.
- Provide a clear skip option.

### Buttons

Primary:

```text
Continue
```

Secondary:

```text
Skip this step
```

### Photo Upload Requirements

- Allow multiple photos
- Allow upload from camera or photo library
- Support common mobile image formats where possible: JPG, PNG, HEIC
- Photos should attach to the lead / appointment record

### Backend Requirements

Save:

- Uploaded photos, if any
- Note text, if any
- Whether the user skipped the step

Make photos and notes visible to dispatch and technicians.

---

## Step 5: Choose Appointment

### Screen Title

```text
Choose your appointment
```

### Flow

1. Select appointment day
2. Select appointment window

### Time Slots

For today, only show two appointment windows:

```text
8am–12pm
12pm–4pm
```

### Recommended Date Display

- Today
- Tomorrow
- Next available dates

### Same-Day Logic

If same-day appointments are available, highlight:

```text
Same-day appointments available
```

If no same-day appointments are available, show:

```text
Next available appointment
```

### Backend Requirements

Save:

- Selected date
- Selected time window
- Availability source
- Appointment hold timestamp, if applicable

Optional:

- Temporarily hold the selected time window while the user completes the remaining steps.

---

## Step 6: Property Details

### Screen Title

```text
Where do you need service?
```

### Inputs

- Street Address
- City
- State
- ZIP / Postal Code
- Email Address
- Additional Notes

### Rules

- Street address required
- City required
- State required
- ZIP should prefill from Step 1
- Email optional
- Additional notes optional

### Additional Notes Placeholder

```text
Anything else you’d like us to know?
```

### Backend Requirements

Save:

- Full property address
- Email address, if provided
- Additional notes, if provided

---

## Step 7: Review & Confirm

### Screen Title

```text
Review your appointment
```

### Show Customer

- Service category: Garage Door or Gate
- Selected service type
- Answers to service questions
- Optional details, if provided
- Appointment date
- Appointment time window
- Name
- Phone number
- Service address
- Email, if provided
- Uploaded photos, if provided

### Trust Elements

Display near confirmation CTA:

```text
Family-owned local company
Licensed & insured
CSLB #1154002
Warranty-backed service
```

Optional:

```text
Serving San Diego County and surrounding areas
```

### Primary CTA

```text
Book Appointment
```

### Secondary CTA

```text
Back
```

### Backend Requirements

Upon clicking “Book Appointment”:

- Finalize appointment
- Create job / appointment in CRM or field service system
- Attach all customer responses
- Attach uploaded photos
- Preserve attribution data
- Mark partial lead as completed
- Notify dispatch

---

## Step 8: Confirmation

### Screen Title

```text
You’re booked
```

### Confirmation Message

```text
Thanks, [First Name]. Your appointment is confirmed. Our team will contact you if we need any additional information before your visit.
```

### Show

- Appointment date
- Appointment time window
- Service address
- Phone number
- What happens next

### Post-Booking Actions

- Send confirmation SMS
- Send confirmation email if email was provided
- Create dispatch notification
- Store customer answers and photos
- Preserve marketing attribution
- Mark abandoned lead as completed, if applicable

---

## 5. Data Model

## Lead / Appointment Fields

```json
{
  "session_id": "string",
  "lead_status": "partial | completed | abandoned",
  "source": "string",
  "utm_source": "string",
  "utm_medium": "string",
  "utm_campaign": "string",
  "utm_content": "string",
  "utm_term": "string",

  "zip_code": "string",
  "service_area_valid": true,

  "first_name": "string",
  "last_name": "string",
  "mobile_phone": "string",
  "email": "string",

  "primary_category": "garage_door | gate",
  "service_type": "string",

  "answers": {
    "can_open_close": "yes | no",
    "estimated_age": "less_than_8_years | 8_years_or_older | not_sure",
    "replacement_type": "basic_functional | nicer_more_features | not_sure",
    "multiple_doors": "yes | no",
    "opener_need": "repair_existing | replace | add_opener | not_sure",
    "gate_type": "swing | sliding | pedestrian | not_sure"
  },

  "optional_note": "string",
  "uploaded_photo_urls": ["string"],

  "appointment_date": "YYYY-MM-DD",
  "appointment_window": "8am-12pm | 12pm-4pm",

  "street_address": "string",
  "city": "string",
  "state": "string",

  "additional_notes": "string",

  "created_at": "datetime",
  "updated_at": "datetime",
  "completed_at": "datetime"
}
```

---

## 6. Abandoned Booking Logic

A partial lead should be created after Step 2 once the customer provides:

- ZIP code
- First name
- Mobile phone

If the customer does not complete booking, the lead should remain available for follow-up.

### Suggested Lead Statuses

```text
partial
completed
abandoned
```

### Suggested Abandonment Trigger

Mark as abandoned if:

```text
lead_status = partial
AND no completed appointment
AND no activity for X minutes
```

The exact follow-up timing can be configured later.

---

## 7. UX Requirements

### General

- Mobile-first design
- Large buttons
- Minimal typing
- One primary question per screen where possible
- Clear progress indicator
- Easy back navigation
- No forced account creation
- No SMS verification
- No required photo upload
- No technical jargon

### Tone

Friendly, direct, and reassuring.

Example tone:

```text
Let’s get your appointment started.
```

Not:

```text
Create an account to begin your service request.
```

---

## 8. Progress Indicator

Recommended progress labels:

```text
Service Area → Contact → Service → Details → Schedule → Confirm
```

Or numeric:

```text
Step 1 of 6
```

Keep it simple and avoid making the flow feel long.

---

## 9. Integrations

The scheduler should be built so it can eventually integrate with:

- CRM / field service system
- Dispatch calendar
- SMS provider
- Email provider
- Photo/file storage
- Marketing attribution tracking
- Call tracking

Near-term, the engineer can store the lead and appointment internally if the FSM integration is not ready.

---

## 10. Admin / Configuration Requirements

The business should be able to configure:

- Serviceable ZIP codes
- Available appointment dates
- Available time windows
- Same-day availability
- Phone number displayed for fallback CTA
- Service options
- Confirmation message
- SMS/email templates
- Abandoned booking follow-up timing

---

## 11. Acceptance Criteria

The scheduler is complete when:

- A customer can enter a ZIP code and determine service availability.
- A customer can provide first name and mobile phone early in the flow.
- A partial lead is created after Step 2.
- A customer can choose Garage Door or Gate.
- Garage Door branch supports:
  - Repairs & Service
  - Door / Panel Replacement
  - Opener Service / Replacement
- Gate branch supports:
  - Repairs & Service
  - Gate Opener Service / Replacement
  - New Gate / Gate Replacement
- The customer can optionally upload photos or add text.
- The customer can skip optional details entirely.
- The customer can select an appointment date and one of the available appointment windows.
- Today’s appointment windows are limited to:
  - 8am–12pm
  - 12pm–4pm
- The customer can enter property details.
- The customer can review and confirm the appointment.
- A completed appointment record is created after confirmation.
- Confirmation SMS is sent after booking.
- Email confirmation is sent only if email was provided.
- Abandoned partial leads are retained for follow-up.
- The flow works well on mobile.
