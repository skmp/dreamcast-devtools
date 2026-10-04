import { type ReactNode } from "react";
import { Box, Container, Stack, Typography } from "@mui/material";
import { documentationSections } from "../layout/documentationSections";

type AnchorHeadingProps = {
  id: string;
  level: 1 | 2 | 3;
  title: string;
  children?: ReactNode;
};

const AnchorHeading = ({ id, level, title, children }: AnchorHeadingProps) => {
  const HeadingTag = `h${level}` as const;

  return (
    <Stack id={id} spacing={1} sx={{ position: "relative" }}>
      <Typography component={HeadingTag} variant={level === 1 ? "h4" : level === 2 ? "h5" : "h6"} sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
};

const renderSectionContent = (section: typeof documentationSections[number]) => {
  return (
    <Stack spacing={section.subsections ? 3 : 2}>
      {section.content?.map((paragraph) => (
        <Typography key={paragraph} variant="body1" color="text.secondary">
          {paragraph}
        </Typography>
      ))}
      {section.subsections?.map((sub) => (
        <AnchorHeading key={sub.id} id={sub.id} level={sub.level} title={sub.title}>
          <Stack spacing={1.25}>
            {sub.items.map((item) => (
              <Stack key={item} direction="row" spacing={1.5} alignItems="flex-start">
                <Typography variant="body2" color="primary" sx={{ mt: "3px" }}>
                  •
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {item}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </AnchorHeading>
      ))}
    </Stack>
  );
};

export const DocumentationPanel = () => {
  return (
    <Box sx={{ height: "100%", overflow: "auto" }}>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack spacing={4}>
          {documentationSections.map((section) => (
            <AnchorHeading key={section.id} id={section.id} level={section.level} title={section.title}>
              {renderSectionContent(section)}
            </AnchorHeading>
          ))}
        </Stack>
      </Container>
    </Box>
  );
};
