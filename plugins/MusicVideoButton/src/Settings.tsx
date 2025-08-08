import React from "react";
import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaSwitchSetting } from "@luna/ui";

export const storage = await ReactiveStore.getPluginStorage("MusicVideoButton", {
  seekOnSwitch: true
});

export const Settings = () => {
  const [seekOnSwitch, setSeekOnSwitch] = React.useState<boolean>(storage.seekOnSwitch);

  return (
    <LunaSettings>
      <LunaSwitchSetting
        {...({
          title: "Resume position when switching",
          checked: seekOnSwitch,
          onChange: (_: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
            setSeekOnSwitch((storage.seekOnSwitch = checked));
          },
        } as any)}
      />
    </LunaSettings>
  );
};