'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { FlowState, SchedulerConfig } from '../lib/types';
import { loadFlowState, saveFlowState, INITIAL_FLOW_STATE } from '../lib/storage';
import ProgressBar from './ui/ProgressBar';
import BackButton from './ui/BackButton';
import StepZip from './steps/StepZip';
import StepLeadCapture from './steps/StepLeadCapture';
import StepServiceCategory from './steps/StepServiceCategory';
import StepServiceType from './steps/StepServiceType';
import StepQuestion from './steps/StepQuestion';
import StepOptionalDetails from './steps/StepOptionalDetails';
import StepSchedule from './steps/StepSchedule';
import StepPropertyDetails from './steps/StepPropertyDetails';
import StepReview from './steps/StepReview';

interface Props {
  config: SchedulerConfig;
  widgetKey: string;
}

// Section labels for progress bar
const SECTION_LABELS = ['Service Area', 'Contact', 'Service', 'Details', 'Schedule', 'Confirm'];

// Step → section index (1-based)
function stepToSection(step: number): number {
  if (step === 1) return 1;
  if (step === 2) return 2;
  if (step >= 3 && step <= 7) return 3;
  if (step === 8) return 4;
  if (step === 9) return 5;
  if (step >= 10) return 6;
  return 1;
}

/**
 * Some service types (annual_maintenance) have no diagnostic questions — skip steps 5-7.
 * Branches with only 2 questions skip step 7.
 * Step 7 is only present for:
 *   - GD Door/Panel Replacement
 *   - Gate Opener Service/Replacement
 */
function hasAnyQuestions(state: FlowState): boolean {
  return state.service_type !== 'annual_maintenance';
}

function hasThirdQuestion(state: FlowState): boolean {
  const cat = state.primary_category;
  const type = state.service_type;
  return (
    (cat === 'garage_door' && type === 'door_panel_replacement') ||
    (cat === 'gate' && type === 'gate_opener_service')
  );
}

function getNextStep(current: number, next: Partial<FlowState>, prevState: FlowState): number {
  const merged: FlowState = { ...prevState, ...next };
  const after = current + 1;
  // Skip all question steps for service types with no diagnostic questions
  if (after === 5 && !hasAnyQuestions(merged)) {
    return 8;
  }
  // Skip step 7 if the branch only has 2 questions
  if (after === 7 && !hasThirdQuestion(merged)) {
    return 8;
  }
  return after;
}

function getPrevStep(current: number, state: FlowState): number {
  const before = current - 1;
  // Skip all question steps going backwards for service types with no questions
  if (before >= 5 && before <= 7 && !hasAnyQuestions(state)) {
    return 4;
  }
  // Skip step 7 going backwards if the branch only has 2 questions
  if (before === 7 && !hasThirdQuestion(state)) {
    return 6;
  }
  return Math.max(1, before);
}

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const SESSION_KEY = 'castle_scheduler_session_id';

function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return generateSessionId();
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = generateSessionId();
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return generateSessionId();
  }
}

// ---- Branch question definitions ----

interface QuestionDef {
  field: keyof FlowState;
  question: string;
  options: { label: string; value: string }[];
}

function getQ1(state: FlowState): QuestionDef | null {
  const cat = state.primary_category;
  const type = state.service_type;

  if (cat === 'garage_door') {
    if (type === 'repairs_service') {
      return {
        field: 'can_open_close',
        question: 'Are you able to open and close your door?',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      };
    }
    if (type === 'door_panel_replacement') {
      return {
        field: 'replacement_type',
        question: 'What type of door are you looking for?',
        options: [
          { label: 'Something Basic and Functional', value: 'basic_functional' },
          { label: 'Something Nicer with More Features', value: 'nicer_more_features' },
          { label: 'Not sure', value: 'not_sure' },
        ],
      };
    }
    if (type === 'opener_service') {
      return {
        field: 'opener_need',
        question: 'What do you need help with?',
        options: [
          { label: 'Repair existing opener', value: 'repair_existing' },
          { label: 'Replace opener', value: 'replace' },
          { label: 'Add opener to existing door', value: 'add_opener' },
          { label: 'Not sure', value: 'not_sure' },
        ],
      };
    }
  }

  if (cat === 'gate') {
    if (type === 'repairs_service') {
      return {
        field: 'can_open_close',
        question: 'Is your gate able to open and close?',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      };
    }
    if (type === 'gate_opener_service') {
      return {
        field: 'opener_need',
        question: 'What do you need help with?',
        options: [
          { label: 'Repair existing opener', value: 'repair_existing' },
          { label: 'Replace opener', value: 'replace' },
          { label: 'Add opener to existing gate', value: 'add_opener' },
          { label: 'Not sure', value: 'not_sure' },
        ],
      };
    }
    if (type === 'new_gate_replacement') {
      return {
        field: 'replacement_type',
        question: 'What type of gate are you looking for?',
        options: [
          { label: 'Something Basic and Functional', value: 'basic_functional' },
          { label: 'Something Nicer with More Features', value: 'nicer_more_features' },
          { label: 'Not sure', value: 'not_sure' },
        ],
      };
    }
  }

  return null;
}

function getQ2(state: FlowState): QuestionDef | null {
  const cat = state.primary_category;
  const type = state.service_type;

  if (cat === 'garage_door') {
    if (type === 'repairs_service') {
      return {
        field: 'estimated_age',
        question: 'What is the estimated age of your garage door?',
        options: [
          { label: 'Less than 8 years old', value: 'less_than_8_years' },
          { label: '8 years or older', value: '8_years_or_older' },
          { label: 'Not sure', value: 'not_sure' },
        ],
      };
    }
    if (type === 'door_panel_replacement') {
      return {
        field: 'estimated_age',
        question: 'What is the estimated age of your garage door?',
        options: [
          { label: 'Less than 8 years old', value: 'less_than_8_years' },
          { label: '8 years or older', value: '8_years_or_older' },
          { label: 'Not sure', value: 'not_sure' },
        ],
      };
    }
    if (type === 'opener_service') {
      return {
        field: 'can_open_close',
        question: 'Is your garage door able to open and close?',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      };
    }
  }

  if (cat === 'gate') {
    if (type === 'repairs_service') {
      return {
        field: 'gate_type',
        question: 'What type of gate do you have?',
        options: [
          { label: 'Swing Gate', value: 'swing' },
          { label: 'Sliding Gate', value: 'sliding' },
          { label: 'Not sure', value: 'not_sure' },
        ],
      };
    }
    if (type === 'gate_opener_service') {
      return {
        field: 'can_open_close',
        question: 'Is your gate able to open and close?',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      };
    }
    if (type === 'new_gate_replacement') {
      return {
        field: 'gate_type',
        question: 'What type of gate do you need?',
        options: [
          { label: 'Swing Gate', value: 'swing' },
          { label: 'Sliding Gate', value: 'sliding' },
          { label: 'Pedestrian Gate', value: 'pedestrian' },
          { label: 'Not sure', value: 'not_sure' },
        ],
      };
    }
  }

  return null;
}

function getQ3(state: FlowState): QuestionDef | null {
  const cat = state.primary_category;
  const type = state.service_type;

  if (cat === 'garage_door' && type === 'door_panel_replacement') {
    return {
      field: 'multiple_doors',
      question: 'Do you have more than one garage door?',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    };
  }

  if (cat === 'gate' && type === 'gate_opener_service') {
    return {
      field: 'gate_type',
      question: 'What type of gate do you have?',
      options: [
        { label: 'Swing Gate', value: 'swing' },
        { label: 'Sliding Gate', value: 'sliding' },
        { label: 'Not sure', value: 'not_sure' },
      ],
    };
  }

  return null;
}

export default function FlowShell({ config, widgetKey }: Props) {
  const [state, setState] = useState<FlowState>(INITIAL_FLOW_STATE);
  const [mounted, setMounted] = useState(false);
  const sessionIdRef = useRef<string>('');

  useEffect(() => {
    const saved = loadFlowState();
    setState(saved);
    sessionIdRef.current = getOrCreateSessionId();
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) {
      saveFlowState(state);
    }
  }, [state, mounted]);

  useEffect(() => {
    if (mounted) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [state.currentStep, mounted]);

  const handleNext = useCallback(
    function handleNext(partial: Partial<FlowState>) {
      setState((prev) => {
        const next = { ...prev, ...partial };
        const nextStep = getNextStep(prev.currentStep, partial, prev);
        return { ...next, currentStep: nextStep };
      });
    },
    []
  );

  function handleBack() {
    setState((prev) => {
      const prevStep = getPrevStep(prev.currentStep, prev);
      return { ...prev, currentStep: prevStep };
    });
  }

  if (!mounted) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--color-bg)',
        }}
      >
        <p style={{ color: 'var(--color-text-muted)' }}>Loading...</p>
      </div>
    );
  }

  if (!config.scheduling_enabled) {
    return (
      <div
        style={{
          minHeight: '100vh',
          backgroundColor: 'var(--color-bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem 1rem',
        }}
      >
        <div
          style={{
            backgroundColor: 'var(--color-white)',
            borderRadius: 'var(--radius-large)',
            boxShadow: 'var(--shadow-card)',
            padding: '2.5rem 2rem',
            maxWidth: '480px',
            width: '100%',
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: '1.5rem',
              fontWeight: 700,
              margin: '0 0 1rem',
              color: 'var(--color-text)',
            }}
          >
            Scheduling Unavailable
          </h1>
          <p style={{ color: 'var(--color-text-muted)', margin: '0 0 1.5rem' }}>
            {config.scheduling_disabled_message}
          </p>
          <a
            href={`tel:${config.office_phone.replace(/\D/g, '')}`}
            style={{
              display: 'inline-block',
              backgroundColor: 'var(--color-primary)',
              color: '#fff',
              fontFamily: 'var(--font-heading)',
              fontWeight: 600,
              fontSize: '1rem',
              padding: '0.75rem 2rem',
              borderRadius: 'var(--radius-input)',
              textDecoration: 'none',
              minHeight: '44px',
            }}
          >
            {config.office_phone}
          </a>
        </div>
      </div>
    );
  }

  const showBack = state.currentStep > 1;
  const currentSection = stepToSection(state.currentStep);

  function renderStep() {
    const step = state.currentStep;

    // Step 1 — ZIP
    if (step === 1) {
      return <StepZip state={state} config={config} onNext={handleNext} />;
    }

    // Step 2 — Lead Capture
    if (step === 2) {
      return (
        <StepLeadCapture
          state={state}
          widgetKey={widgetKey}
          sessionId={sessionIdRef.current}
          onNext={handleNext}
        />
      );
    }

    // Step 3 — Service Category
    if (step === 3) {
      return <StepServiceCategory state={state} onNext={handleNext} />;
    }

    // Step 4 — Service Type
    if (step === 4) {
      return <StepServiceType state={state} onNext={handleNext} />;
    }

    // Step 5 — Question 1
    if (step === 5) {
      const q = getQ1(state);
      if (!q) return null;
      return (
        <StepQuestion
          question={q.question}
          options={q.options}
          value={state[q.field] as string | null}
          onChange={(val) => setState((prev) => ({ ...prev, [q.field]: val }))}
          onNext={() => handleNext({})}
        />
      );
    }

    // Step 6 — Question 2
    if (step === 6) {
      const q = getQ2(state);
      if (!q) return null;
      return (
        <StepQuestion
          question={q.question}
          options={q.options}
          value={state[q.field] as string | null}
          onChange={(val) => setState((prev) => ({ ...prev, [q.field]: val }))}
          onNext={() => handleNext({})}
        />
      );
    }

    // Step 7 — Question 3 (only for branches with 3 questions)
    if (step === 7) {
      const q = getQ3(state);
      if (!q) return null;
      return (
        <StepQuestion
          question={q.question}
          options={q.options}
          value={state[q.field] as string | null}
          onChange={(val) => setState((prev) => ({ ...prev, [q.field]: val }))}
          onNext={() => handleNext({})}
        />
      );
    }

    // Step 8 — Optional Details
    if (step === 8) {
      return <StepOptionalDetails state={state} widgetKey={widgetKey} onNext={handleNext} />;
    }

    // Step 9 — Schedule
    if (step === 9) {
      return <StepSchedule state={state} config={config} widgetKey={widgetKey} onNext={handleNext} />;
    }

    // Step 10 — Property Details
    if (step === 10) {
      return <StepPropertyDetails state={state} onNext={handleNext} />;
    }

    // Step 11 — Review
    if (step === 11) {
      return (
        <StepReview
          state={state}
          config={config}
          widgetKey={widgetKey}
          sessionId={sessionIdRef.current}
          onNext={handleNext}
        />
      );
    }

    return null;
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--color-bg)',
        padding: '1rem 1rem 3rem',
      }}
    >
      <div style={{ maxWidth: '520px', margin: '0 auto' }}>
        <ProgressBar
          currentSection={currentSection}
          totalSections={SECTION_LABELS.length}
          labels={SECTION_LABELS}
        />

        <div
          style={{
            backgroundColor: 'var(--color-white)',
            borderRadius: 'var(--radius-large)',
            boxShadow: 'var(--shadow-card)',
            padding: '1.75rem 1.5rem',
            marginTop: '0.75rem',
          }}
        >
          {showBack && (
            <div style={{ marginBottom: '1rem' }}>
              <BackButton onClick={handleBack} />
            </div>
          )}
          {renderStep()}
        </div>
      </div>
    </div>
  );
}
