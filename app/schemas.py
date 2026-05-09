from pydantic import BaseModel, EmailStr
from typing import Optional, List, Any
from uuid import UUID
from datetime import datetime


# ── Company Master ──────────────────────────────────────────────────────────

class CompanyBase(BaseModel):
    name: str
    registration_number: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None


class CompanyCreate(CompanyBase):
    pass


class CompanyUpdate(BaseModel):
    name: Optional[str] = None
    registration_number: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None


class Company(CompanyBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ── Invoice ─────────────────────────────────────────────────────────────────

class InvoiceBase(BaseModel):
    original_filename: Optional[str] = None
    status: str = "processed"


class InvoiceUpdate(BaseModel):
    status: Optional[str] = None
    extracted_data: Optional[dict] = None
    company_id: Optional[UUID] = None
    matching_score: Optional[float] = None


class MatchResult(BaseModel):
    company_id: str
    company_name: str
    score: float
    reason: str


class Invoice(InvoiceBase):
    id: UUID
    s3_key: str
    file_type: Optional[str] = None
    extracted_data: Optional[Any] = None
    company_id: Optional[UUID] = None
    matching_score: Optional[float] = None
    ai_input_tokens: int = 0
    ai_output_tokens: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class InvoiceWithMatches(Invoice):
    match_candidates: Optional[List[MatchResult]] = None


# ── Approval ─────────────────────────────────────────────────────────────────

class ApprovalBase(BaseModel):
    invoice_id: UUID
    approver_id: str
    approver_name: Optional[str] = None
    comment: Optional[str] = None


class ApprovalCreate(ApprovalBase):
    pass


class ApprovalUpdate(BaseModel):
    status: str  # approved / rejected
    comment: Optional[str] = None


class Approval(ApprovalBase):
    id: UUID
    status: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ── Tenant ───────────────────────────────────────────────────────────────────

class TenantProvision(BaseModel):
    slug: str
    name: str


# ── Auth / User ───────────────────────────────────────────────────────────────

class TenantInfo(BaseModel):
    slug: str
    name: str


class UserCreate(BaseModel):
    email: EmailStr
    password: str
    name: Optional[str] = None
    role: str = "user"
    tenant_slugs: List[str] = []


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    password: Optional[str] = None
    name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    tenant_slugs: Optional[List[str]] = None


class UserResponse(BaseModel):
    id: UUID
    email: str
    name: Optional[str] = None
    role: str
    is_active: bool
    tenants: List[TenantInfo] = []
    created_at: datetime

    class Config:
        from_attributes = True


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
