import { redirect } from 'next/navigation'

// The Commission area lands on the Technicians view (per-tech detail).
export default function CommissionIndexPage() {
  redirect('/admin/commission/techs')
}
