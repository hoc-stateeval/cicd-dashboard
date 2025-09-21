-- Script to generate INSERT statements for a single table
-- Usage: Modify @TableName below and run this script

DECLARE @TableName NVARCHAR(128) = 'District'  -- Change this to the table you want to export

DECLARE @SQL NVARCHAR(MAX) = ''
DECLARE @Columns NVARCHAR(MAX) = ''
DECLARE @Values NVARCHAR(MAX) = ''

-- Get column list
SELECT @Columns = STUFF((
    SELECT ', [' + COLUMN_NAME + ']'
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = @TableName
    ORDER BY ORDINAL_POSITION
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '')

-- Generate values expression
SELECT @Values = STUFF((
    SELECT ', ' +
        CASE
            WHEN DATA_TYPE IN ('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier')
            THEN 'ISNULL('''''''' + REPLACE(CAST([' + COLUMN_NAME + '] AS NVARCHAR(MAX)), '''''''', '''''''''''') + '''''''', ''NULL'')'
            WHEN DATA_TYPE IN ('datetime', 'datetime2', 'date', 'time', 'datetimeoffset')
            THEN 'ISNULL('''''''' + CONVERT(VARCHAR, [' + COLUMN_NAME + '], 121) + '''''''', ''NULL'')'
            WHEN DATA_TYPE = 'bit'
            THEN 'ISNULL(CAST([' + COLUMN_NAME + '] AS VARCHAR), ''NULL'')'
            ELSE 'ISNULL(CAST([' + COLUMN_NAME + '] AS VARCHAR), ''NULL'')'
        END
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = @TableName
    ORDER BY ORDINAL_POSITION
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '')

-- Check for identity columns
IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = @TableName
    AND COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA+'.'+TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1
)
BEGIN
    PRINT 'SET IDENTITY_INSERT [' + @TableName + '] ON'
END

-- Generate the INSERT statements
SET @SQL = 'SELECT ''INSERT INTO [' + @TableName + '] (' + @Columns + ') VALUES ('' + ' + @Values + ' + '');'' FROM [' + @TableName + ']'

EXEC(@SQL)

-- Disable identity insert if needed
IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = @TableName
    AND COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA+'.'+TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1
)
BEGIN
    PRINT 'SET IDENTITY_INSERT [' + @TableName + '] OFF'
END

PRINT 'GO'