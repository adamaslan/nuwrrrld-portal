"""Domain exceptions. Feature runners catch VendorGapError per feature so one gap never kills a run."""


class LabError(Exception):
    """Base class for nwf-lab errors."""


class VendorGapError(LabError):
    """A vendor refused an endpoint (401/403) or cannot serve this need."""

    def __init__(self, vendor: str, endpoint: str, status: int | None = None):
        self.vendor, self.endpoint, self.status = vendor, endpoint, status
        suffix = f" {status}" if status is not None else ""
        super().__init__(f"vendor_gap: {vendor} {endpoint}{suffix}")


class RateBudgetExceeded(LabError):
    """The vendor returned 429."""

    def __init__(self, vendor: str):
        self.vendor = vendor
        super().__init__(f"rate budget exceeded: {vendor}")


class MissingInputError(LabError):
    """A feature needs a bundle field that is empty."""
