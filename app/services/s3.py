import boto3
from botocore.exceptions import ClientError
from ..config import settings

_s3_client = None


def get_s3():
    global _s3_client
    if _s3_client is None:
        kwargs = {"region_name": settings.AWS_REGION}
        if settings.AWS_ACCESS_KEY_ID:
            kwargs["aws_access_key_id"] = settings.AWS_ACCESS_KEY_ID
            kwargs["aws_secret_access_key"] = settings.AWS_SECRET_ACCESS_KEY
        _s3_client = boto3.client("s3", **kwargs)
    return _s3_client


def upload_file(file_content: bytes, s3_key: str, content_type: str = "application/octet-stream") -> str:
    s3 = get_s3()
    s3.put_object(
        Bucket=settings.S3_BUCKET_NAME,
        Key=s3_key,
        Body=file_content,
        ContentType=content_type,
    )
    return s3_key


def get_presigned_url(s3_key: str, expires_in: int = 3600) -> str:
    s3 = get_s3()
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET_NAME, "Key": s3_key},
        ExpiresIn=expires_in,
    )


def delete_file(s3_key: str) -> None:
    s3 = get_s3()
    try:
        s3.delete_object(Bucket=settings.S3_BUCKET_NAME, Key=s3_key)
    except ClientError:
        pass


def move_file(old_key: str, new_key: str, content_type: str = "application/octet-stream") -> None:
    """Copy object to new_key then delete old_key."""
    s3 = get_s3()
    s3.copy_object(
        CopySource={"Bucket": settings.S3_BUCKET_NAME, "Key": old_key},
        Bucket=settings.S3_BUCKET_NAME,
        Key=new_key,
        ContentType=content_type,
        MetadataDirective="REPLACE",
    )
    delete_file(old_key)
