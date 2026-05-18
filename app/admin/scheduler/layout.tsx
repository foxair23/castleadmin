import SchedulerSubNav from './SchedulerSubNav'

export default function SchedulerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SchedulerSubNav />
      {children}
    </div>
  )
}
