'use client';

import { useState, useEffect, useCallback } from 'react';
import { FlowState, SchedulerConfig } from '../lib/types';
import { loadFlowState, saveFlowState, INITIAL_FLOW_STATE } from '../lib/storage';
import ProgressBar from './ui/ProgressBar';
import BackButton from './ui/BackButton';
import StepServiceType from './flow/StepServiceType';
import StepGDCategory from './flow/StepGDCategory';
import StepGDDiagnostic from './flow/StepGDDiagnostic';
import StepGDUniversal from './flow/StepGDUniversal';
import StepContact from './flow/StepContact';
import StepAddress from './flow/StepAddress';
import StepSchedule from './flow/StepSchedule';
import StepDetails from './flow/StepDetails';
import StepIncentive from './flow/StepIncentive';
import StepReview from './flow/StepReview';

interface Props {
  config: SchedulerConfig;
  widgetKey: string;
}

const STEP_COUNT = 10;

export default function FlowShell({ config, widgetKey }: Props) {
  const [state, setState] = useState<FlowState>(INITIAL_FLOW_STATE);
  const [mounted, setMounted] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const saved = loadFlowState();
    setState(saved);
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

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  }, []);

  function handleNext(partial: Partial<FlowState>) {
    setState((prev) => {
      const next = { ...prev, ...partial };
      const nextStep = getNextStep(prev.currentStep, next, config);
      return { ...next, currentStep: nextStep };
    });
  }

  function handleBack() {
    setState((prev) => {
      const prevStep = getPrevStep(prev.currentStep, prev, config);
      return { ...prev, currentStep: prevStep };
    });
  }

  function getNextStep(current: number, next: Partial<FlowState>, cfg: SchedulerConfig): number {
    const after = current + 1;
    if (after === 9 && !cfg.incentive_banner_enabled) {
      return 10;
    }
    return after;
  }

  function getPrevStep(current: number, s: FlowState, cfg: SchedulerConfig): number {
    const before = current - 1;
    if (before === 9 && !cfg.incentive_banner_enabled) {
      return 8;
    }
    return before;
  }

  const totalSteps = config.incentive_banner_enabled ? STEP_COUNT : STEP_COUNT - 1;

  const displayStep = config.incentive_banner_enabled
    ? state.currentStep
    : state.currentStep > 9
    ? state.currentStep - 1
    : state.currentStep;

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

  function renderStep() {
    switch (state.currentStep) {
      case 1:
        return (
          <StepServiceType
            state={state}
            onNext={handleNext}
            onGateComing={() => showToast('Gate scheduling coming soon!')}
          />
        );
      case 2:
        return <StepGDCategory state={state} config={config} onNext={handleNext} />;
      case 3:
        return <StepGDDiagnostic state={state} config={config} onNext={handleNext} />;
      case 4:
        return <StepGDUniversal state={state} onNext={handleNext} />;
      case 5:
        return <StepContact state={state} config={config} onNext={handleNext} />;
      case 6:
        return <StepAddress state={state} onNext={handleNext} />;
      case 7:
        return <StepSchedule state={state} config={config} onNext={handleNext} />;
      case 8:
        return <StepDetails state={state} onNext={handleNext} />;
      case 9:
        return <StepIncentive state={state} config={config} onNext={handleNext} />;
      case 10:
        return <StepReview state={state} config={config} onNext={handleNext} widgetKey={widgetKey} />;
      default:
        return null;
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--color-bg)',
        padding: '1rem 1rem 3rem',
      }}
    >
      <div
        style={{
          maxWidth: '520px',
          margin: '0 auto',
        }}
      >
        <header style={{ textAlign: 'center', padding: '1.25rem 0 0.5rem' }}>
          <p
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 700,
              fontSize: '1.1rem',
              color: 'var(--color-primary)',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            Castle Garage Doors & Gates
          </p>
          <p
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '0.8rem',
              color: 'var(--color-text-muted)',
              margin: '0.125rem 0 0',
            }}
          >
            Online Booking
          </p>
        </header>

        <ProgressBar currentStep={displayStep} totalSteps={totalSteps} />

        <div
          style={{
            backgroundColor: 'var(--color-white)',
            borderRadius: 'var(--radius-large)',
            boxShadow: 'var(--shadow-card)',
            padding: '1.75rem 1.5rem',
            marginTop: '1rem',
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

      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: '2rem',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: '#1A1A1A',
            color: '#fff',
            fontFamily: 'var(--font-heading)',
            fontWeight: 500,
            fontSize: '0.9rem',
            padding: '0.75rem 1.5rem',
            borderRadius: '999px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            whiteSpace: 'nowrap',
            zIndex: 1000,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
