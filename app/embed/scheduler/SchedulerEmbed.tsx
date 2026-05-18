'use client';

import { SchedulerConfig } from './lib/types';
import FlowShell from './components/FlowShell';

interface Props {
  config: SchedulerConfig;
  widgetKey: string;
}

export default function SchedulerEmbed({ config, widgetKey }: Props) {
  return <FlowShell config={config} widgetKey={widgetKey} />;
}
