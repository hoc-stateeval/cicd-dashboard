-- Simple manual approach for District table
USE stateeval
GO

SET QUOTED_IDENTIFIER ON
GO

PRINT 'SET IDENTITY_INSERT [District] ON'

SELECT
    'INSERT INTO [District] ([Id], [Name], [StateCode], [IsDeleted], [DeletedByUserId], [CreatedDateTime], [ModifiedByUserId], [ModifiedDateTime]) VALUES (' +
    CAST([Id] AS VARCHAR) + ', ' +
    CASE WHEN [Name] IS NULL THEN 'NULL' ELSE '''' + REPLACE(CAST([Name] AS NVARCHAR(MAX)), '''', '''''') + '''' END + ', ' +
    CASE WHEN [StateCode] IS NULL THEN 'NULL' ELSE '''' + REPLACE(CAST([StateCode] AS NVARCHAR(MAX)), '''', '''''') + '''' END + ', ' +
    CAST([IsDeleted] AS VARCHAR) + ', ' +
    CASE WHEN [DeletedByUserId] IS NULL THEN 'NULL' ELSE CAST([DeletedByUserId] AS VARCHAR) END + ', ' +
    CASE WHEN [CreatedDateTime] IS NULL THEN 'NULL' ELSE '''' + CONVERT(VARCHAR, [CreatedDateTime], 121) + '''' END + ', ' +
    CASE WHEN [ModifiedByUserId] IS NULL THEN 'NULL' ELSE CAST([ModifiedByUserId] AS VARCHAR) END + ', ' +
    CASE WHEN [ModifiedDateTime] IS NULL THEN 'NULL' ELSE '''' + CONVERT(VARCHAR, [ModifiedDateTime], 121) + '''' END +
    ');'
FROM [District]

PRINT 'SET IDENTITY_INSERT [District] OFF'
PRINT 'GO'