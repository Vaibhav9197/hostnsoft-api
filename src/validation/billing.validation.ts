import { z } from "zod";

// Request bodies for src/routes/billing.routes.ts. Field names match Lago's
// customer object 1:1 (snake_case) so the parsed body is passed straight
// through to createLagoCustomer without a mapping step.
export const createCustomerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  address_line1: z.string().min(1).optional(),
  address_line2: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  zipcode: z.string().min(1).optional(),
  // ISO 3166-1 alpha-2, which is what both Lago and Stripe expect.
  country: z.string().length(2).toUpperCase().optional(),
  legal_name: z.string().min(1).optional(),
  tax_identification_number: z.string().min(1).optional(),
  // ISO 4217; must match the currency of plans the customer will be
  // subscribed to, so validation of "is it a supported currency" is Lago's.
  currency: z.string().length(3).toUpperCase().optional(),
  timezone: z.string().min(1).optional(),
});

export type CreateCustomerBody = z.infer<typeof createCustomerSchema>;

export const changePlanSchema = z.object({
  plan_code: z.string().min(1),
});
