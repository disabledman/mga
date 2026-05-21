-- MGA analytics schema (MSSQL). Mock API uses SQLite with equivalent structure.

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = N'analytics')
    EXEC('CREATE SCHEMA analytics');
GO

CREATE TABLE analytics.EventRaw (
    EventId          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    TenantId         NVARCHAR(32)     NOT NULL,
    SiteId           NVARCHAR(32)     NOT NULL,
    EventName        NVARCHAR(64)     NOT NULL,
    EventTimeUtc     DATETIME2(3)     NOT NULL,
    SessionId        CHAR(64)         NOT NULL,
    VisitorId        CHAR(64)         NOT NULL,
    PageUrl          NVARCHAR(2048)   NULL,
    PagePath         NVARCHAR(2048)   NULL,
    Referrer         NVARCHAR(2048)   NULL,
    UserAgent        NVARCHAR(512)    NULL,
    DeviceType       NVARCHAR(16)     NULL,
    Browser          NVARCHAR(64)     NULL,
    Os               NVARCHAR(64)     NULL,
    CountryCode      CHAR(2)          NULL,
    TrackId          NVARCHAR(128)    NULL,
    PropertiesJson   NVARCHAR(MAX)    NULL,
    ConsentGranted   BIT              NOT NULL DEFAULT 0,
    IngestedAtUtc    DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

CREATE INDEX IX_EventRaw_TenantSiteTime
    ON analytics.EventRaw (TenantId, SiteId, EventTimeUtc DESC);
GO

CREATE TABLE analytics.DailyPageViews (
    StatDate     DATE           NOT NULL,
    TenantId     NVARCHAR(32)   NOT NULL,
    SiteId       NVARCHAR(32)   NOT NULL,
    PagePath     NVARCHAR(2048) NOT NULL,
    ViewCount    BIGINT         NOT NULL DEFAULT 0,
    CONSTRAINT PK_DailyPageViews PRIMARY KEY (StatDate, TenantId, SiteId, PagePath)
);
GO

CREATE TABLE analytics.DailyClicks (
    StatDate     DATE           NOT NULL,
    TenantId     NVARCHAR(32)   NOT NULL,
    SiteId       NVARCHAR(32)   NOT NULL,
    TrackId      NVARCHAR(128)  NOT NULL,
    ClickCount   BIGINT         NOT NULL DEFAULT 0,
    CONSTRAINT PK_DailyClicks PRIMARY KEY (StatDate, TenantId, SiteId, TrackId)
);
GO

CREATE TABLE analytics.HourlySiteStats (
    StatHour     DATETIME2(0)   NOT NULL,
    TenantId     NVARCHAR(32)   NOT NULL,
    SiteId       NVARCHAR(32)   NOT NULL,
    PageViews    BIGINT         NOT NULL DEFAULT 0,
    Clicks       BIGINT         NOT NULL DEFAULT 0,
    CustomEvents BIGINT         NOT NULL DEFAULT 0,
    CONSTRAINT PK_HourlySiteStats PRIMARY KEY (StatHour, TenantId, SiteId)
);
GO

CREATE TABLE analytics.Sites (
    SiteId       NVARCHAR(32)   NOT NULL PRIMARY KEY,
    TenantId     NVARCHAR(32)   NOT NULL,
    Name         NVARCHAR(128)  NOT NULL,
    WriteKey     NVARCHAR(64)   NOT NULL UNIQUE,
    AllowedHosts NVARCHAR(MAX)  NOT NULL,
    IsActive     BIT            NOT NULL DEFAULT 1
);
GO
